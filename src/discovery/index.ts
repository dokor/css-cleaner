import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { AnalysisWarning, DiscoveredProject, DiscoveryOptions, ReactSyntax, ResolveStyleImport, StyleSyntax } from "../contracts.js";
import { compareLocations, compareText, projectPath, sourceLocation } from "../conventions.js";
import { compileGlobs, loadProjectConfig } from "./config.js";
import { DiscoveryError, ioCode } from "./errors.js";

export { DiscoveryError } from "./errors.js";
export type { DiscoveryErrorCode } from "./errors.js";
export { createStyleImportResolver } from "./resolver.js";

/** Resolve config, discover and read sources without running the app. */
export type DiscoverProject = (options: DiscoveryOptions) => Promise<DiscoveredProject>;

/** Bind root/config/catalog once, then resolve requests from JSX analysis. */
export type CreateStyleImportResolver = (project: DiscoveredProject) => ResolveStyleImport;

const STYLE_SYNTAXES: readonly string[] = ["css", "scss", "sass"];
const REACT_SYNTAXES: readonly string[] = ["js", "jsx", "ts", "tsx"];

export const discoverProject: DiscoverProject = async (options) => {
  if (typeof options.rootDir !== "string" || options.rootDir.trim() === "" || options.rootDir.includes("\0")) {
    throw new DiscoveryError("invalid-root", "Expected a non-empty project directory path.");
  }
  const rootDir = resolve(options.rootDir);
  try {
    if (!(await stat(rootDir)).isDirectory()) {
      throw new DiscoveryError("invalid-root", `Project path is not a directory: ${rootDir}.`);
    }
  } catch (cause) {
    if (cause instanceof DiscoveryError) throw cause;
    throw new DiscoveryError("invalid-root", `Cannot scan project directory ${rootDir} (${ioCode(cause)}).`, { cause });
  }
  const config = await loadProjectConfig(rootDir, options);
  const included = compileGlobs(config.include);
  const excluded = compileGlobs(config.exclude);
  const files: string[] = [];
  const warnings: AnalysisWarning[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(rootDir, directory), { withFileTypes: true });
    } catch (cause) {
      throw new DiscoveryError("unreadable-directory", `Cannot read project directory ${directory || "."} (${ioCode(cause)}).`, {
        ...(directory === "" ? {} : { location: sourceLocation(projectPath(directory), 1) }), cause,
      });
    }
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const file = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (excluded(file) || ((entry.isDirectory() || entry.isSymbolicLink()) && excluded(`${file}/`))) continue;
      if (entry.isSymbolicLink()) {
        warnings.push({
          stage: "discovery", code: "symlink-skipped", reason: "Symbolic links are not followed; linked sources may be outside the scan root.",
          location: sourceLocation(projectPath(file), 1), affectedScopes: [{ scope: "project" }],
        });
      } else if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile() && included(file)) {
        const syntax = extname(file).slice(1);
        if (STYLE_SYNTAXES.includes(syntax) || REACT_SYNTAXES.includes(syntax)) files.push(file);
      }
    }
  }
  await walk("");

  const styles: DiscoveredProject["styles"][number][] = [];
  const react: DiscoveredProject["react"][number][] = [];
  for (const path of files.sort(compareText)) {
    const file = projectPath(path);
    let content: string;
    try {
      content = await readFile(join(rootDir, path), "utf8");
    } catch (cause) {
      throw new DiscoveryError("unreadable-source", `Cannot read source ${file} (${ioCode(cause)}).`, {
        location: sourceLocation(file, 1), cause,
      });
    }
    const syntax = extname(file).slice(1);
    if (STYLE_SYNTAXES.includes(syntax)) {
      styles.push({ file, syntax: syntax as StyleSyntax, scope: file.endsWith(`.module.${syntax}`) ? "module" : "global", content });
    } else {
      react.push({ file, syntax: syntax as ReactSyntax, content });
    }
  }
  warnings.sort((left, right) => compareLocations(left.location, right.location) || compareText(left.code, right.code) || compareText(left.reason, right.reason));
  return { config, styles, react, warnings };
};
