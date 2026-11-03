import type { AnalysisStage, SourceLocation } from "../contracts.js";
import type { DiscoveryErrorCode } from "../discovery/errors.js";

export type ScanProjectStage = AnalysisStage | "matching";
export type ScanProjectErrorCode = DiscoveryErrorCode | "invalid-options" | "scan-failed";

/** A fatal scan failure; recoverable analysis warnings remain in the report. */
export class ScanProjectError extends Error {
  readonly location: SourceLocation | undefined;

  constructor(
    readonly code: ScanProjectErrorCode,
    readonly stage: ScanProjectStage,
    message: string,
    options: { readonly location?: SourceLocation; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ScanProjectError";
    this.location = options.location;
  }
}
