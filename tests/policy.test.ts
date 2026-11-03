import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePolicy, getExitCode, PolicyError, projectPath, renderReport, resolvePolicy, scanProject, sourceLocation,
} from "../src/index.js";
import type {
  AnalysisReport, AnalysisWarning, Confidence, Diagnostic, DiagnosticCategory, EvaluatePolicy, PolicyConfig, ResolvePolicy, Severity,
} from "../src/index.js";

const empty: AnalysisReport = { schemaVersion: 1, completeness: "complete", diagnostics: [], warnings: [] };
const categories: readonly DiagnosticCategory[] = ["unused-class", "undefined-class", "dynamic-usage", "unresolved-import", "analysis-warning"];
const confidences: readonly Confidence[] = ["low", "medium", "high"];

function diagnostic(category: DiagnosticCategory, confidence: Confidence): Diagnostic {
  return { category, confidence, reason: "Evidence from the engine.", location: sourceLocation(projectPath("src/Card.tsx"), 3, 8), candidates: [] };
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("public policy functions preserve default and legacy decisions across every category/confidence", () => {
  const resolve: ResolvePolicy = resolvePolicy;
  const evaluate: EvaluatePolicy = evaluatePolicy;
  const defaults = resolve();
  assert.equal(defaults.requireComplete, false);
  for (const category of categories) {
    assert.deepEqual(defaults.rules[category], { enabled: true, severity: category === "dynamic-usage" ? "info" : "warning", minConfidence: "high" });
    for (const confidence of confidences) {
      for (const completeness of ["complete", "partial"] as const) {
        const report = { ...empty, completeness, diagnostics: [diagnostic(category, confidence)] };
        assert.equal(evaluate(report).failed, false);
        assert.equal(getExitCode({ status: "success", report }, {}), 0);
        assert.equal(getExitCode({ status: "success", report }, { failOnMissing: true }), category === "undefined-class" && confidence === "high" ? 1 : 0);
      }
    }
  }
});

test("blocking requires an enabled error whose confidence reaches the configured threshold", () => {
  // Expected accepted levels are explicit policy boundaries, independent of the evaluator implementation.
  const accepted: Readonly<Record<Confidence, readonly Confidence[]>> = {
    high: ["high"], medium: ["medium", "high"], low: ["low", "medium", "high"],
  };
  for (const category of categories) {
    for (const severity of ["info", "warning", "error"] satisfies Severity[]) {
      for (const minConfidence of confidences) {
        for (const confidence of confidences) {
          const report = { ...empty, diagnostics: [diagnostic(category, confidence)] };
          const evaluation = evaluatePolicy(report, { rules: { [category]: { severity, minConfidence } } });
          const expected = severity === "error" && accepted[minConfidence].includes(confidence);
          assert.equal(evaluation.failed, expected, `${category}/${severity}/${minConfidence}/${confidence}`);
          assert.equal(evaluation.blockingCount, expected ? 1 : 0);
          assert.equal(evaluation.diagnostics[0]?.diagnostic.confidence, confidence);
          assert.equal(evaluation.diagnostics[0]?.severity, severity);
          assert.equal(evaluation.diagnostics[0]?.blocking, expected);
        }
      }
    }
  }
});

test("disabled rules retain evidence without blocking and severity never raises confidence", () => {
  const report = freeze({ ...empty, diagnostics: [diagnostic("undefined-class", "low"), diagnostic("unused-class", "high")] });
  const policy = freeze({ rules: { "undefined-class": { severity: "error" }, "unused-class": { enabled: false, severity: "error" } } } satisfies PolicyConfig);
  const before = structuredClone({ report, policy });
  const result = evaluatePolicy(report, policy);
  assert.equal(result.failed, false);
  assert.equal(result.diagnostics[0]?.severity, "error");
  assert.equal(result.diagnostics[0]?.diagnostic.confidence, "low");
  assert.equal(result.diagnostics[1]?.enabled, false);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0]?.diagnostic, report.diagnostics[0]);
  assert.deepEqual({ report, policy }, before);
  for (const format of ["terminal", "markdown"] as const) {
    const text = renderReport(report, format, policy);
    assert.match(text, /Gravité : (?:` )?error/);
    assert.match(text, /Confiance : (?:` )?low/);
    assert.match(text, /Règle : désactivée/);
    assert.match(text, /Diagnostics bloquants : 0/);
  }
  assert.deepEqual(JSON.parse(renderReport(report, "json", policy)), report);
  assert.deepEqual({ report, policy }, before);
});

test("config, shortcut and explicit overrides merge by field without mutating their inputs", () => {
  const base = freeze({
    requireComplete: true,
    rules: { "unused-class": { severity: "error", minConfidence: "medium" }, "undefined-class": { enabled: false, severity: "info", minConfidence: "low" } },
  } satisfies PolicyConfig);
  const overrides = freeze({ requireComplete: false, rules: { "unused-class": { enabled: false }, "dynamic-usage": { severity: "info" } } } satisfies PolicyConfig);
  const before = structuredClone({ base, overrides });
  const result = resolvePolicy(base, overrides, { failOnMissing: true });
  assert.equal(result.requireComplete, false);
  assert.deepEqual(result.rules["unused-class"], { enabled: false, severity: "error", minConfidence: "medium" });
  assert.deepEqual(result.rules["undefined-class"], { enabled: true, severity: "error", minConfidence: "high" });
  assert.equal(result.rules["dynamic-usage"].severity, "info");
  assert.deepEqual({ base, overrides }, before);
  assert.throws(() => resolvePolicy(base, { rules: { "undefined-class": { severity: "warning" } } }, { failOnMissing: true }), (error: unknown) => {
    assert.ok(error instanceof PolicyError);
    assert.equal(error.code, "conflicting-options");
    assert.equal(error.field, "overrides.rules.undefined-class");
    return true;
  });
});

test("strict completeness is independent of diagnostic counts, severity and disabled rules", () => {
  const partial = { ...empty, completeness: "partial" as const };
  assert.equal(evaluatePolicy(partial).failed, false);
  const evaluation = evaluatePolicy(partial, { requireComplete: true, rules: { "analysis-warning": { enabled: false } } });
  assert.equal(evaluation.failed, true);
  assert.equal(evaluation.incompleteFailure, true);
  assert.equal(evaluation.blockingCount, 0);
  assert.equal(getExitCode({ status: "success", report: partial }, { policy: { requireComplete: true } }), 1);
  assert.equal(evaluatePolicy(empty, { requireComplete: true }).failed, false);
  assert.equal(partial.completeness, "partial");
  for (const failOnMissing of [false, true]) {
    assert.equal(getExitCode({ status: "error", reason: "Source cannot be read." }, { policy: { requireComplete: true }, failOnMissing }), 2);
  }
});

test("a warning represented as a diagnostic is counted once for CI", () => {
  const warning: AnalysisWarning = {
    code: "jsx-parse-error", stage: "jsx", reason: "Parsing was partial.",
    location: sourceLocation(projectPath("src/Card.tsx"), 3, 8), affectedScopes: [{ scope: "project" }],
  };
  const report: AnalysisReport = {
    ...empty, completeness: "partial", warnings: [warning],
    diagnostics: [{ ...diagnostic("analysis-warning", "low"), reason: `jsx/${warning.code} : ${warning.reason}` }],
  };
  const result = evaluatePolicy(report, { rules: { "analysis-warning": { severity: "error", minConfidence: "low" } } });
  assert.equal(result.blockingCount, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(report.warnings.length, 1);
});

test("invalid policy fields are rejected with stable codes and actionable paths", () => {
  const invalid = [
    [null, "policy"], [[], "policy"], [{ rules: null }, "policy.rules"], [{ requireComplete: "yes" }, "policy.requireComplete"],
    [{ unknown: true }, "policy.unknown"], [{ rules: { typo: {} } }, "policy.rules.typo"],
    [{ rules: { "unused-class": null } }, "policy.rules.unused-class"],
    [{ rules: { "unused-class": { enabled: "false" } } }, "policy.rules.unused-class.enabled"],
    [{ rules: { "unused-class": { severity: "fatal" } } }, "policy.rules.unused-class.severity"],
    [{ rules: { "unused-class": { minConfidence: "certain" } } }, "policy.rules.unused-class.minConfidence"],
    [{ rules: { "unused-class": { threshold: "high" } } }, "policy.rules.unused-class.threshold"],
  ] as const;
  for (const [value, field] of invalid) {
    for (const apply of [
      () => resolvePolicy(value as unknown as PolicyConfig),
      () => evaluatePolicy(empty, value as unknown as PolicyConfig),
    ]) {
      assert.throws(apply, (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.equal(error.code, "invalid-policy");
        assert.equal(error.field, field);
        assert.match(error.message, /expected|unknown/);
        return true;
      });
    }
  }
  assert.throws(() => resolvePolicy({ rules: { "unused-class": { severity: "fatal" as Severity } } }, { rules: { "unused-class": { severity: "info" } } }), PolicyError);
});

test("scanProject keeps raw analysis separate from the configured policy in memory", async () => {
  const result = await scanProject({ snapshot: {
    config: { rootDir: "/virtual", include: [], exclude: [], aliases: {}, externalGlobals: [], policy: { rules: { "unused-class": { severity: "error" } } } },
    styles: [{ file: projectPath("Card.module.css"), syntax: "css", scope: "module", content: ".unused {}" }], react: [], warnings: [],
  } });
  assert.equal(result.report.schemaVersion, 1);
  assert.deepEqual(result.report.diagnostics.map((entry) => [entry.category, entry.confidence]), [["unused-class", "high"]]);
  assert.ok(!("severity" in result.report.diagnostics[0]!));
  const evaluation = evaluatePolicy(result.report, result.project.config.policy);
  assert.equal(evaluation.blockingCount, 1);
  assert.equal(getExitCode({ status: "success", report: result.report }, { policy: result.project.config.policy! }), 1);
});
