import type { AnalysisInput, AnalysisReport } from "../contracts.js";

/** Future entry point: reconcile definitions/usages conservatively, without reading files. */
export type MatchClasses = (input: AnalysisInput) => AnalysisReport;
