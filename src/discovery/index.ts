import type { DiscoveredProject, DiscoveryOptions, ResolveStyleImport } from "../contracts.js";

/** Future entry point: resolve config, discover and read sources without running the app. */
export type DiscoverProject = (options: DiscoveryOptions) => Promise<DiscoveredProject>;

/** Future factory: bind root/config/catalog once, then resolve requests from JSX analysis. */
export type CreateStyleImportResolver = (project: DiscoveredProject) => ResolveStyleImport;
