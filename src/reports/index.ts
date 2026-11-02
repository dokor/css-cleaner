import type { AnalysisReport, ExitCode, ExitCodeOptions, ReportFormat, ScanOutcome } from "../contracts.js";

/** Future entry point: deterministic text/JSON/Markdown rendering, without writing output. */
export type RenderReport = (report: AnalysisReport, format: ReportFormat) => string;

/** Future policy: success=0, certain missing class with failOnMissing=1, fatal error=2. */
export type GetExitCode = (outcome: ScanOutcome, options: ExitCodeOptions) => ExitCode;
