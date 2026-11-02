import type { StyleAnalysis, StyleSource } from "../contracts.js";

/** Future entry point: extract definitions and warnings from CSS, SCSS and indented Sass. */
export type AnalyzeStyles = (sources: readonly StyleSource[]) => Promise<StyleAnalysis>;
