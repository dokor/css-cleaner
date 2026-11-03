import type { Confidence, DiagnosticCategory, PolicyConfig, PolicyRule, Severity } from "../contracts.js";
import { PolicyError } from "./errors.js";

export const diagnosticCategories = [
  "unused-class", "undefined-class", "dynamic-usage", "unresolved-import", "analysis-warning",
] as const satisfies readonly DiagnosticCategory[];

function invalid(field: string, detail: string): never {
  throw new PolicyError("invalid-policy", field, detail);
}

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(field, "expected an object");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${field}.${key}`, `unknown option; expected ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field, "expected a boolean");
  return value;
}

function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(field, `expected ${choices.join(" | ")}`);
  return value as T;
}

/** Validate and copy partial settings without applying defaults or accessing disk. */
export function parsePolicyConfig(value: unknown, field = "policy"): PolicyConfig {
  const input = record(value, field, ["rules", "requireComplete"]);
  let rules: PolicyConfig["rules"];
  if (Object.hasOwn(input, "rules")) {
    const entries = record(input.rules, `${field}.rules`, diagnosticCategories);
    rules = Object.fromEntries(Object.entries(entries).map(([category, value]) => {
      const path = `${field}.rules.${category}`;
      const rule = record(value, path, ["enabled", "severity", "minConfidence"]);
      const parsed: Partial<PolicyRule> = {
        ...(Object.hasOwn(rule, "enabled") ? { enabled: boolean(rule.enabled, `${path}.enabled`) } : {}),
        ...(Object.hasOwn(rule, "severity") ? { severity: choice<Severity>(rule.severity, `${path}.severity`, ["error", "warning", "info"]) } : {}),
        ...(Object.hasOwn(rule, "minConfidence") ? { minConfidence: choice<Confidence>(rule.minConfidence, `${path}.minConfidence`, ["high", "medium", "low"]) } : {}),
      };
      return [category, parsed];
    }));
  }
  return {
    ...(rules === undefined ? {} : { rules }),
    ...(Object.hasOwn(input, "requireComplete") ? { requireComplete: boolean(input.requireComplete, `${field}.requireComplete`) } : {}),
  };
}
