import { posix } from "node:path";
import type { DiscoveredProject, ProjectPath, ResolveStyleImport, StyleImportReference } from "../contracts.js";
import { compareText, projectPath } from "../conventions.js";

interface AliasMatch {
  readonly key: string;
  readonly targets: readonly string[];
  readonly capture: string;
  readonly prefixLength: number;
  readonly exact: boolean;
}

function aliasPaths(specifier: string, aliases: DiscoveredProject["config"]["aliases"]): string[] {
  const matches: AliasMatch[] = [];
  for (const [key, targets] of Object.entries(aliases)) {
    const star = key.indexOf("*");
    if (star < 0) {
      if (specifier === key || specifier.startsWith(`${key}/`)) {
        matches.push({ key, targets, capture: specifier.slice(key.length), prefixLength: key.length, exact: specifier === key });
      }
    } else {
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        matches.push({ key, targets, capture: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLength: prefix.length, exact: false });
      }
    }
  }
  matches.sort((left, right) => Number(right.exact) - Number(left.exact) || right.prefixLength - left.prefixLength || compareText(left.key, right.key));
  const match = matches[0];
  if (!match) return [];
  return match.targets.map((target) => match.key.includes("*")
    ? target.replace("*", () => match.capture)
    : `${target}${match.capture}`);
}

function candidatesFor(path: string): ProjectPath[] {
  const normalized = posix.normalize(path);
  // Traversal may be valid within the root, but must never escape it.
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:/.test(normalized)) return [];
  const directoryOnly = normalized.endsWith("/") || normalized === ".";
  const base = normalized.replace(/\/$/u, "");
  const indexes = ["css", "scss", "sass"].map((extension) => posix.join(base, `index.${extension}`));
  const candidates = directoryOnly
    ? indexes
    : /\.(?:css|scss|sass)$/u.test(base) || (posix.extname(base) !== "" && !base.endsWith(".module"))
      ? [base]
      : [...["css", "scss", "sass"].map((extension) => `${base}.${extension}`), ...indexes];
  return candidates.map(projectPath);
}

/** Resolve only to discovered styles; excluded or external files cannot create false identities. */
export function createStyleImportResolver(project: DiscoveredProject): ResolveStyleImport {
  const styles = new Map(project.styles.map((style) => [style.file, style]));
  return async (request) => {
    const unknown = (reason: string, candidates: readonly ProjectPath[] = []): StyleImportReference => ({
      ...request, status: "unknown", reason, candidates,
    });
    const specifier = request.specifier.replaceAll("\\", "/");
    if (specifier === "" || /[\0?#]/u.test(specifier)) {
      return unknown("Empty style imports, NUL characters, queries and fragments are not supported.");
    }
    const paths = specifier.startsWith("./") || specifier.startsWith("../")
      ? [posix.join(posix.dirname(request.location.file), specifier)]
      : aliasPaths(specifier, project.config.aliases);
    if (paths.length === 0) return unknown("No configured alias matches this non-relative style import.");

    const attempted = new Set<ProjectPath>();
    for (const path of paths) {
      const candidates = candidatesFor(path);
      for (const candidate of candidates) attempted.add(candidate);
      const found = candidates.filter((candidate) => styles.has(candidate));
      if (found.length > 1) return unknown("Several discovered styles match this import; use an explicit file extension.", found.sort(compareText));
      const target = found[0];
      const style = target === undefined ? undefined : styles.get(target);
      if (style) return { ...request, status: "resolved", target: style.file, scope: style.scope };
    }
    return attempted.size === 0
      ? unknown("The style import resolves outside the project root.")
      : unknown("No discovered style matches this import (missing, excluded or unsupported file).", [...attempted].sort(compareText));
  };
}
