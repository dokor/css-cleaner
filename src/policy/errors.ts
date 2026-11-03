export type PolicyErrorCode = "invalid-policy" | "conflicting-options";

/** Invalid declarative policy or incompatible programmatic/CLI overrides. */
export class PolicyError extends Error {
  constructor(readonly code: PolicyErrorCode, readonly field: string, readonly detail: string) {
    super(`${field}: ${detail}`);
    this.name = "PolicyError";
  }
}
