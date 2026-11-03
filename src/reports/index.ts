import type {
  AnalysisReport, AnalysisScope, ClassSymbol, DiagnosticCategory, ExitCode,
  ExitCodeOptions, PolicyConfig, PolicyEvaluation, ReportFormat, ScanOutcome, SourceLocation,
} from "../contracts.js";
import { compareText } from "../conventions.js";
import { evaluatePolicy, resolvePolicy } from "../policy/index.js";

/** Deterministic text/JSON/Markdown rendering, without writing output. */
export type RenderReport = (report: AnalysisReport, format: ReportFormat, policy?: PolicyConfig) => string;

/** Accepted policy=0, policy failure=1, fatal error=2. Legacy failOnMissing is retained. */
export type GetExitCode = (outcome: ScanOutcome, options: ExitCodeOptions) => ExitCode;

const categories = [
  ["unused-class", "Classes probablement inutilisées"],
  ["undefined-class", "Classes manquantes"],
  ["dynamic-usage", "Usages dynamiques à vérifier"],
  ["unresolved-import", "Imports non résolus"],
  ["analysis-warning", "Diagnostics d’analyse"],
] as const satisfies readonly (readonly [DiagnosticCategory, string])[];

/** Pure renderer. Array order belongs to the producers and is preserved within each category. */
export const renderReport: RenderReport = (report, format, policy) => {
  const evaluation = policy === undefined ? undefined : evaluatePolicy(report, policy);
  switch (format) {
    case "json":
      // Canonical object keys also make equivalent objects with different insertion orders identical.
      // Arrays retain the contract's producer ordering, including candidates and affected scopes.
      return JSON.stringify(report, (_key: string, value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)));
      }, 2) + "\n";
    case "terminal":
      return renderReadableReport(report, false, evaluation);
    case "markdown":
      return renderReadableReport(report, true, evaluation);
  }
};

export const getExitCode: GetExitCode = (outcome, options) => {
  if (outcome.status === "error") return 2;
  const policy = resolvePolicy(options.policy, {}, { failOnMissing: options.failOnMissing ?? false });
  return evaluatePolicy(outcome.report, policy).failed ? 1 : 0;
};

function locationText(location: SourceLocation): string {
  return `${location.file}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
}

function symbolText(symbol: ClassSymbol): string {
  return symbol.scope === "global"
    ? `global ${JSON.stringify(symbol.name)}`
    : `module ${JSON.stringify(symbol.name)} (${symbol.file})`;
}

function scopeText(scope: AnalysisScope): string {
  return scope.scope === "module" ? `module (${scope.file})` : scope.scope;
}

/** Keep source text on one line and prevent terminal control sequences from becoming output commands. */
function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function markdownText(value: string): string {
  return singleLine(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_\[\]{}()#+.!|~\-]/g, "\\$&");
}

function markdownCode(value: string): string {
  const text = singleLine(value);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter} ${text} ${delimiter}`;
}

function renderReadableReport(report: AnalysisReport, markdown: boolean, evaluation?: PolicyEvaluation): string {
  const prose = markdown ? markdownText : singleLine;
  const code = markdown ? markdownCode : singleLine;
  const heading = (label: string) => markdown ? `## ${label}` : label;
  const assessments = new Map(evaluation?.diagnostics.map((entry) => [entry.diagnostic, entry]));
  const groups = categories.map(([category, label]) => ({
    category, label, diagnostics: report.diagnostics.filter((diagnostic) => diagnostic.category === category),
  }));
  const lines = [
    markdown ? "# CSS Cleaner" : "CSS Cleaner",
    "",
    report.completeness === "partial" ? "Scan incomplet (partial)." : "Scan complet (complete).",
    "",
    `Diagnostics : ${report.diagnostics.length}`,
    ...groups.map(({ label, diagnostics }) => `- ${label} : ${diagnostics.length}`),
    `- Avertissements : ${report.warnings.length}`,
    ...(evaluation === undefined ? [] : [
      "", `Politique CI : ${evaluation.failed ? "refusée" : "acceptée"}`,
      `Diagnostics bloquants : ${evaluation.blockingCount}`,
      `Analyse complète exigée : ${evaluation.policy.requireComplete ? "oui" : "non"}`,
      ...(evaluation.incompleteFailure ? ["Échec CI : analyse partielle alors qu’une analyse complète est exigée."] : []),
    ]),
  ];

  for (const { category, label, diagnostics } of groups) {
    // Always show the three primary categories, even for an empty report.
    if (diagnostics.length === 0 && (category === "unresolved-import" || category === "analysis-warning")) continue;
    lines.push("", heading(`${label} (${diagnostics.length})`), "");
    if (diagnostics.length === 0) lines.push("Aucun résultat.");
    for (const diagnostic of diagnostics) {
      const symbol = diagnostic.symbol ? ` — ${code(symbolText(diagnostic.symbol))}` : "";
      const assessment = assessments.get(diagnostic);
      lines.push(
        `- ${code(locationText(diagnostic.location))}${symbol} [${diagnostic.category}]`,
        ...(assessment === undefined ? [] : [
          `  - Règle : ${assessment.enabled ? "activée" : "désactivée"}`,
          `  - Gravité : ${code(assessment.severity)}`,
          `  - Seuil CI : ${code(assessment.minConfidence)}`,
          `  - Bloquant : ${assessment.blocking ? "oui" : "non"}`,
        ]),
        `  - Confiance : ${code(diagnostic.confidence)}`,
        `  - Raison : ${prose(diagnostic.reason)}`,
      );
      if (diagnostic.candidates.length > 0) {
        lines.push("  - Candidats compatibles :");
        for (const candidate of diagnostic.candidates) {
          lines.push(
            `    - ${code(locationText(candidate.location))} — ${code(symbolText(candidate.symbol))}`,
            `      - Confiance : ${code(candidate.confidence)}`,
            `      - Raison : ${prose(candidate.reason)}`,
          );
        }
      }
    }
  }

  lines.push("", heading(`Avertissements (${report.warnings.length})`), "");
  if (report.warnings.length === 0) lines.push("Aucun avertissement.");
  for (const warning of report.warnings) {
    lines.push(
      `- ${code(locationText(warning.location))} — ${code(warning.stage)} / ${code(warning.code)}`,
      `  - Raison : ${prose(warning.reason)}`,
      `  - Portées affectées : ${warning.affectedScopes.length === 0
        ? "aucune (informatif)" : warning.affectedScopes.map((scope) => code(scopeText(scope))).join(", ")}`,
    );
  }
  return lines.join("\n") + "\n";
}
