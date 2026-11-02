import type { SourceLocation } from "../contracts.js";

export type DiscoveryErrorCode =
  | "invalid-config"
  | "unreadable-config"
  | "invalid-root"
  | "unreadable-directory"
  | "unreadable-source";

/** Fatal discovery failures can be translated directly into a CLI error outcome. */
export class DiscoveryError extends Error {
  readonly location: SourceLocation | undefined;

  constructor(
    readonly code: DiscoveryErrorCode,
    message: string,
    options: { readonly location?: SourceLocation; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DiscoveryError";
    this.location = options.location;
  }
}

export function ioCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown";
}
