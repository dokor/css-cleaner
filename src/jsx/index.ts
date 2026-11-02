import type { JsxAnalysis, JsxAnalysisInput } from "../contracts.js";

/** Future entry point: collect imports plus static/dynamic class usages from React sources. */
export type AnalyzeJsx = (input: JsxAnalysisInput) => Promise<JsxAnalysis>;
