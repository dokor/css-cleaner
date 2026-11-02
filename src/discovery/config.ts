import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import type {
  ClassPatternPart, DiscoveryOptions, ExternalGlobalClass, ProjectConfig,
} from "../contracts.js";
import { projectPath, sourceLocation } from "../conventions.js";
import { DiscoveryError, ioCode } from "./errors.js";

export const CONFIG_FILE = "css-cleaner.config.json";

const DEFAULT_INCLUDE = ["**/*.{js,jsx,ts,tsx,css,scss,sass}"];
const DEFAULT_EXCLUDE = [
  "node_modules", ".git", ".hg", ".svn", ".next", "dist", "build", "out", "coverage",
  ".turbo", ".cache", ".vercel", ".yarn", ".pnpm", ".pnpm-store", ".test-dist",
].flatMap((directory) => [`**/${directory}`, `**/${directory}/**`]);

function invalid(field: string, detail: string): never {
  throw new DiscoveryError("invalid-config", `${CONFIG_FILE}: ${field}: ${detail}`, {
    location: sourceLocation(projectPath(CONFIG_FILE), 1),
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(field, "expected an object");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${field}.${key}`, "unknown option");
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    invalid(field, "expected a non-empty string without NUL characters");
  }
  return value;
}

function relativePath(value: unknown, field: string): string {
  const path = text(value, field).replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    invalid(field, "expected a root-relative path without '.' or '..' segments");
  }
  return path;
}

/** All matching uses normalized project paths, including dot directories, on every OS. */
export function compileGlobs(patterns: readonly string[]): (file: string) => boolean {
  const matchers = patterns.map((pattern) => picomatch(pattern, {
    dot: true, windows: false, strictBrackets: true, nonegate: true,
  }));
  return (file) => matchers.some((matches) => matches(file));
}

function globs(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(field, "expected an array of glob strings");
  return value.map((entry: unknown, index: number) => {
    const itemField = `${field}[${index}]`;
    // A directory suffix is shorthand for its whole subtree.
    const raw = text(entry, itemField).replaceAll("\\", "/");
    const pattern = relativePath(raw.endsWith("/") ? `${raw}**` : raw, itemField);
    if (pattern.startsWith("!")) invalid(itemField, "use exclude instead of negated globs");
    try {
      compileGlobs([pattern]);
    } catch (cause) {
      invalid(itemField, `invalid glob (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    return pattern;
  });
}

function aliases(value: unknown): ProjectConfig["aliases"] {
  const entries = record(value, "aliases");
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => {
    const field = `aliases[${JSON.stringify(key)}]`;
    if (
      key === "" || /[\s\\\0?#]/u.test(key) || key.startsWith(".") || key.startsWith("/") ||
      /^[A-Za-z]:/.test(key) || key.endsWith("/") || key.split("*").length > 2
    ) {
      invalid(field, "expected an import alias with at most one '*' wildcard");
    }
    const targets: unknown[] = Array.isArray(entry) ? entry : [entry];
    if (targets.length === 0) invalid(field, "expected at least one path target");
    return [key, targets.map((target, index) => {
      const targetField = `${field}[${index}]`;
      const path = target === "." || target === "./" ? "." : relativePath(target, targetField);
      if (/[?#]/u.test(path) || path.split("*").length > (key.includes("*") ? 2 : 1)) {
        invalid(targetField, "a target may contain one '*' only when its alias has a wildcard");
      }
      return path;
    })];
  }));
}

function classText(value: unknown, field: string): string {
  const name = text(value, field);
  if (/\s/u.test(name)) invalid(field, "expected one class name or pattern without whitespace");
  return name;
}

function externalGlobals(value: unknown): ExternalGlobalClass[] {
  if (!Array.isArray(value)) invalid("externalGlobals", "expected an array of names or { pattern } objects");
  return value.map((entry: unknown, index: number): ExternalGlobalClass => {
    const field = `externalGlobals[${index}]`;
    if (typeof entry === "string") return { kind: "name", name: classText(entry, field) };
    const object = record(entry, field);
    onlyKeys(object, ["pattern"], field);
    const pattern = classText(object.pattern, `${field}.pattern`);
    const parts: ClassPatternPart[] = [];
    for (const [index, literal] of pattern.split("*").entries()) {
      if (index > 0 && parts.at(-1)?.kind !== "unknown") parts.push({ kind: "unknown" });
      if (literal !== "") parts.push({ kind: "literal", value: literal });
    }
    // A non-empty pattern always emits a literal or an unknown fragment.
    const [first, ...rest] = parts;
    if (!first) invalid(`${field}.pattern`, "expected a non-empty pattern");
    return { kind: "pattern", pattern: { parts: [first, ...rest] } };
  });
}

export async function loadProjectConfig(rootDir: string, options: DiscoveryOptions): Promise<ProjectConfig> {
  let local: Record<string, unknown> = {};
  let content: string | undefined;
  try {
    const path = join(rootDir, CONFIG_FILE);
    const info = await lstat(path);
    if (!info.isFile()) {
      throw new DiscoveryError("unreadable-config", `${CONFIG_FILE}: expected a regular configuration file, not a directory or symbolic link.`, {
        location: sourceLocation(projectPath(CONFIG_FILE), 1),
      });
    }
    content = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof DiscoveryError) throw cause;
    if (ioCode(cause) !== "ENOENT") {
      throw new DiscoveryError("unreadable-config", `${CONFIG_FILE}: could not read configuration (${ioCode(cause)})`, {
        location: sourceLocation(projectPath(CONFIG_FILE), 1), cause,
      });
    }
  }
  if (content !== undefined) {
    try {
      local = record(JSON.parse(content.replace(/^\uFEFF/, "")) as unknown, "configuration");
    } catch (cause) {
      if (cause instanceof DiscoveryError) throw cause;
      invalid("JSON", cause instanceof Error ? cause.message : String(cause));
    }
    onlyKeys(local, ["include", "exclude", "aliases", "externalGlobals"], "configuration");
  }
  // Validate even overridden fields so a typo in the local file never goes unnoticed.
  const include = local.include === undefined ? DEFAULT_INCLUDE : globs(local.include, "include");
  const exclude = local.exclude === undefined ? [] : globs(local.exclude, "exclude");
  return {
    rootDir,
    include: options.include === undefined ? [...include] : globs(options.include, "options.include"),
    exclude: [...new Set([
      ...DEFAULT_EXCLUDE, ...exclude,
      ...(options.exclude === undefined ? [] : globs(options.exclude, "options.exclude")),
    ])],
    aliases: local.aliases === undefined ? {} : aliases(local.aliases),
    externalGlobals: local.externalGlobals === undefined ? [] : externalGlobals(local.externalGlobals),
  };
}
