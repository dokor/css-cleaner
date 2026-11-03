import type {
  AnalysisReport, Confidence, ExitCodeOptions, PolicyConfig, PolicyEvaluation, PolicyRule, ResolvedPolicy,
} from "../contracts.js";
import { diagnosticCategories, parsePolicyConfig } from "./config.js";
import { PolicyError } from "./errors.js";

export { PolicyError } from "./errors.js";
export type { PolicyErrorCode } from "./errors.js";

export type ResolvePolicy = (
  config?: PolicyConfig, overrides?: PolicyConfig, options?: Pick<ExitCodeOptions, "failOnMissing">,
) => ResolvedPolicy;
export type EvaluatePolicy = (report: AnalysisReport, policy?: PolicyConfig) => PolicyEvaluation;

/** Defaults < config < legacy shortcut < explicit overrides, with conflicts rejected. */
export const resolvePolicy: ResolvePolicy = (config = {}, overrides = {}, options = {}) => {
  const base = parsePolicyConfig(config);
  const explicit = parsePolicyConfig(overrides, "overrides");
  if (options.failOnMissing && Object.hasOwn(explicit.rules ?? {}, "undefined-class")) {
    throw new PolicyError("conflicting-options", "overrides.rules.undefined-class", "--fail-on-missing cannot be combined with an explicit undefined-class rule; use one or the other.");
  }
  const rules = Object.fromEntries(diagnosticCategories.map((category) => {
    const defaults: PolicyRule = { enabled: true, severity: category === "dynamic-usage" ? "info" : "warning", minConfidence: "high" };
    const shortcut: Partial<PolicyRule> = options.failOnMissing && category === "undefined-class"
      ? { enabled: true, severity: "error", minConfidence: "high" } : {};
    return [category, { ...defaults, ...base.rules?.[category], ...shortcut, ...explicit.rules?.[category] }];
  })) as ResolvedPolicy["rules"];
  return { rules, requireComplete: explicit.requireComplete ?? base.requireComplete ?? false };
};

const confidenceRank: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

/** Evaluate diagnostics once; retain raw confidence and never append warnings as findings. */
export const evaluatePolicy: EvaluatePolicy = (report, config = {}) => {
  const policy = resolvePolicy(config);
  const diagnostics = report.diagnostics.map((diagnostic) => {
    const rule = policy.rules[diagnostic.category];
    return {
      diagnostic, ...rule,
      blocking: rule.enabled && rule.severity === "error" && confidenceRank[diagnostic.confidence] >= confidenceRank[rule.minConfidence],
    };
  });
  const blockingCount = diagnostics.filter((diagnostic) => diagnostic.blocking).length;
  const incompleteFailure = policy.requireComplete && report.completeness === "partial";
  return { policy, diagnostics, blockingCount, incompleteFailure, failed: blockingCount > 0 || incompleteFailure };
};
