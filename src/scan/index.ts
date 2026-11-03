import type { ScanProjectOptions, ScanProjectResult } from "../contracts.js";
import { createStyleImportResolver, discoverProject, DiscoveryError } from "../discovery/index.js";
import { analyzeJsx } from "../jsx/index.js";
import { matchClasses } from "../matching/index.js";
import { analyzeStyles } from "../styles/index.js";
import { ScanProjectError } from "./errors.js";
import type { ScanProjectStage } from "./errors.js";

export { ScanProjectError } from "./errors.js";
export type { ScanProjectErrorCode, ScanProjectStage } from "./errors.js";

export type ScanProject = (options: ScanProjectOptions) => Promise<ScanProjectResult>;

async function runStage<T>(stage: ScanProjectStage, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof ScanProjectError) throw cause;
    throw new ScanProjectError(
      cause instanceof DiscoveryError ? cause.code : "scan-failed",
      stage,
      cause instanceof Error ? cause.message : String(cause),
      { cause, ...(cause instanceof DiscoveryError && cause.location !== undefined ? { location: cause.location } : {}) },
    );
  }
}

/** Analyze a project without rendering, writing reports or choosing a CI policy. */
export const scanProject: ScanProject = async (options) => {
  const project = await runStage("discovery", () => {
    if (options === null || typeof options !== "object") {
      throw new ScanProjectError("invalid-options", "discovery", "Expected scan options with rootDir or snapshot.");
    }
    if ("snapshot" in options) {
      if (options.snapshot === undefined || options.snapshot === null ||
          "rootDir" in options || "include" in options || "exclude" in options) {
        throw new ScanProjectError("invalid-options", "discovery", "snapshot cannot be combined with discovery options.");
      }
      // Capture caller-owned inputs before the first await, so concurrent edits cannot mix revisions.
      return structuredClone(options.snapshot);
    }
    return discoverProject(options);
  });
  const [styles, jsx] = await Promise.all([
    runStage("styles", () => analyzeStyles(project.styles)),
    runStage("jsx", () => analyzeJsx({ sources: project.react, resolveStyleImport: createStyleImportResolver(project) })),
  ]);
  const report = await runStage("matching", () => matchClasses({
    styles, jsx, externalGlobals: project.config.externalGlobals, warnings: project.warnings,
  }));
  return { report, project };
};
