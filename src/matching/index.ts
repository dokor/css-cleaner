import type {
  AnalysisInput, AnalysisReport, AnalysisWarning, ClassDefinition, ClassSymbol, ClassUsage,
  Confidence, Diagnostic, DiagnosticCandidate, SourceLocation, StyleImportReference,
} from "../contracts.js";
import { classSymbolKey, compareDiagnostics, compareLocations, compareText } from "../conventions.js";
import { createScopeConfidence, lowerConfidence, scopeKey, symbolScope } from "./confidence.js";
import type { Assessment, ClassScope } from "./confidence.js";
import { compilePattern, hasKnownFragment } from "./patterns.js";

/** Reconcile definitions/usages conservatively, without reading files. */
export type MatchClasses = (input: AnalysisInput) => AnalysisReport;

function locationKey(location: SourceLocation): readonly unknown[] {
  return [location.file, location.line, location.column ?? null];
}

function compareCandidates(left: DiagnosticCandidate, right: DiagnosticCandidate): number {
  return compareLocations(left.location, right.location) ||
    compareText(classSymbolKey(left.symbol), classSymbolKey(right.symbol)) ||
    compareText(left.confidence, right.confidence) || compareText(left.reason, right.reason);
}

function uniqueCandidates(candidates: readonly DiagnosticCandidate[]): DiagnosticCandidate[] {
  const entries = new Map<string, DiagnosticCandidate>();
  for (const candidate of candidates) {
    entries.set(JSON.stringify([classSymbolKey(candidate.symbol), locationKey(candidate.location),
      candidate.confidence, candidate.reason]), candidate);
  }
  return [...entries.values()].sort(compareCandidates);
}

/** Merge repeated extraction records, while keeping every distinct source position. */
function uniqueDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const entries = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([locationKey(diagnostic.location), diagnostic.category,
      diagnostic.symbol ? classSymbolKey(diagnostic.symbol) : null, diagnostic.confidence, diagnostic.reason]);
    const previous = entries.get(key);
    entries.set(key, { ...diagnostic, candidates: uniqueCandidates([
      ...(previous?.candidates ?? []), ...diagnostic.candidates,
    ]) });
  }
  return [...entries.values()].sort(compareDiagnostics);
}

function collectImports(input: AnalysisInput): StyleImportReference[] {
  const entries = new Map<string, StyleImportReference>();
  const references = [...input.jsx.imports, ...input.jsx.usages.flatMap((usage) =>
    usage.reference.scope === "module" ? [usage.reference.import] : [])];
  for (const reference of references) {
    const resolution = reference.status === "resolved" ? [reference.target, reference.scope] :
      [reference.reason, [...reference.candidates].sort(compareText)];
    entries.set(JSON.stringify([locationKey(reference.location), reference.specifier, reference.binding ?? null,
      reference.status, resolution]), reference);
  }
  return [...entries.values()];
}

function scopeDescription(scope: ClassScope): string {
  return scope.scope === "global" ? "la portée globale du périmètre scanné" : `le module « ${scope.file} »`;
}

function caution(assessment: Assessment): string {
  return assessment.reasons.length > 0 ?
    ` Vérification nécessaire : ${assessment.reasons.map((reason) => reason.trimEnd().replace(/\.+$/u, "")).join(" ; ")}.` : "";
}

function sentence(reason: string): string {
  const trimmed = reason.trimEnd();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function warningScopesKey(warning: AnalysisWarning): string {
  return JSON.stringify(warning.affectedScopes.map((scope) =>
    scope.scope === "project" ? JSON.stringify(["project"]) : scopeKey(scope)).sort(compareText));
}

function usageScope(usage: ClassUsage): ClassScope | undefined {
  if (usage.reference.scope === "global") return { scope: "global" };
  if (usage.reference.import.status === "resolved") return { scope: "module", file: usage.reference.import.target };
  return undefined;
}

function usageSymbol(scope: ClassScope, name: string): ClassSymbol {
  return scope.scope === "global" ? { scope: "global", name } : { scope: "module", file: scope.file, name };
}

export const matchClasses: MatchClasses = (input) => {
  const warnings: AnalysisWarning[] = [
    ...input.warnings, ...input.styles.warnings, ...input.jsx.warnings,
  ].sort((left, right) => compareLocations(left.location, right.location) ||
    compareText(left.stage, right.stage) || compareText(left.code, right.code) || compareText(left.reason, right.reason) ||
    compareText(warningScopesKey(left), warningScopesKey(right)));
  const imports = collectImports(input);
  const { assess, partial } = createScopeConfidence(input, imports, warnings);
  const defined = new Set<string>();
  const definitionsByScope = new Map<string, ClassDefinition[]>();
  for (const definition of input.styles.definitions) {
    const symbol = classSymbolKey(definition.symbol);
    const scope = scopeKey(symbolScope(definition.symbol));
    defined.add(symbol);
    const entries = definitionsByScope.get(scope) ?? [];
    entries.push(definition);
    definitionsByScope.set(scope, entries);
  }
  const externalMatchers = input.externalGlobals.map((external) => external.kind === "name" ?
    (name: string) => name === external.name : compilePattern(external.pattern));
  const diagnostics: Diagnostic[] = warnings.map((warning) => ({
    category: "analysis-warning", confidence: warning.affectedScopes.length > 0 ? "low" : "high",
    reason: `${warning.stage}/${warning.code} : ${warning.reason}`, location: warning.location, candidates: [],
  }));
  for (const reference of imports) {
    if (reference.status === "unknown") diagnostics.push({
      category: "unresolved-import", confidence: "low", location: reference.location,
      reason: `Import non résolu « ${reference.specifier} » : ${reference.reason}`, candidates: [],
    });
  }

  const used = new Set<string>();
  const possible = new Map<string, { confidence: Confidence; expressions: Set<string> }>();
  for (const usage of input.jsx.usages) {
    const scope = usageScope(usage);
    if (usage.kind === "static" && scope) {
      const symbol = usageSymbol(scope, usage.name);
      const key = classSymbolKey(symbol);
      if (defined.has(key)) { used.add(key); continue; }
      if (scope.scope === "global" && externalMatchers.some((matches) => matches(usage.name))) continue;
      const assessment = assess(scope);
      diagnostics.push({
        category: "undefined-class", confidence: assessment.confidence, symbol, location: usage.location, candidates: [],
        reason: `Aucune définition de « ${usage.name} » dans ${scopeDescription(scope)}.` +
          (assessment.confidence === "high" ? " Cette portée a été analysée intégralement." : caution(assessment)),
      });
      continue;
    }

    // A candidate target of an unresolved import is only a possibility, never a successful lookup.
    const scopes: ClassScope[] = scope ? [scope] : usage.reference.scope === "module" &&
      usage.reference.import.status === "unknown" ? usage.reference.import.candidates.map((file) => ({ scope: "module", file })) : [];
    const matches = usage.kind === "dynamic" ? compilePattern(usage.pattern) : (name: string) => name === usage.name;
    const level: Confidence = usage.kind === "dynamic" && hasKnownFragment(usage.pattern) ? "medium" : "low";
    const candidates: DiagnosticCandidate[] = [];
    for (const candidateScope of scopes) {
      const assessment = assess(candidateScope);
      const confidence = scope ? lowerConfidence(level, assessment.confidence) : "low";
      for (const definition of definitionsByScope.get(scopeKey(candidateScope)) ?? []) {
        if (!matches(definition.symbol.name)) continue;
        candidates.push({
          symbol: definition.symbol, location: definition.location, confidence,
          reason: (scope ? `Nom compatible avec ${usage.kind === "dynamic" ? `le motif de « ${usage.expression} »` : "l’usage"} dans ${scopeDescription(candidateScope)}.` :
            "Nom compatible dans une cible possible de l’import non résolu ; la résolution reste à vérifier.") +
            caution(assessment),
        });
        if (usage.kind === "dynamic") {
          const key = classSymbolKey(definition.symbol);
          const previous = possible.get(key);
          const expressions = previous?.expressions ?? new Set<string>();
          expressions.add(usage.expression);
          possible.set(key, { confidence: lowerConfidence(previous?.confidence ?? "high", confidence), expressions });
        }
      }
    }
    if (usage.kind === "dynamic") {
      const assessment = scope ? assess(scope) : { confidence: "low" as const, reasons: ["origine du module non résolue"] };
      diagnostics.push({
        category: "dynamic-usage", confidence: lowerConfidence(level, assessment.confidence),
        reason: `Usage dynamique « ${usage.expression} » : ${sentence(usage.reason)} Les candidats restent des possibilités, sans preuve d’usage.` + caution(assessment),
        location: usage.location, candidates,
      });
    } else {
      diagnostics.push({
        category: "undefined-class", confidence: "low", location: usage.location, candidates,
        reason: `Impossible de vérifier « ${usage.name} » : l’import du module n’est pas résolu.` +
          (usage.reference.scope === "module" && usage.reference.import.status === "unknown" ?
            ` « ${usage.reference.import.specifier} » : ${sentence(usage.reference.import.reason)}` : ""),
      });
    }
  }

  for (const definition of input.styles.definitions) {
    const key = classSymbolKey(definition.symbol);
    if (used.has(key)) continue;
    const scope = symbolScope(definition.symbol);
    const assessment = assess(scope);
    const potential = possible.get(key);
    diagnostics.push({
      category: "unused-class", symbol: definition.symbol, location: definition.location, candidates: [],
      confidence: lowerConfidence(assessment.confidence, potential?.confidence ?? "high"),
      reason: `Aucun usage statique connu de « ${definition.symbol.name} » dans ${scopeDescription(scope)}.` +
        (potential ? ` Usage dynamique compatible : ${[...potential.expressions].sort(compareText).map((expression) => `« ${expression} »`).join(", ")}.` : "") + caution(assessment),
    });
  }
  return { schemaVersion: 1, completeness: partial ? "partial" : "complete", diagnostics: uniqueDiagnostics(diagnostics), warnings };
};
