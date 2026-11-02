import type {
  AnalysisInput, AnalysisScope, AnalysisWarning, ClassSymbol, Confidence, ProjectPath,
  StyleCoverage, StyleImportReference,
} from "../contracts.js";
import { compareText } from "../conventions.js";

export type ClassScope = Exclude<AnalysisScope, { readonly scope: "project" }>;
export interface Assessment {
  readonly confidence: Confidence;
  readonly reasons: readonly string[];
}

const rank = { high: 0, medium: 1, low: 2 } as const;

export function lowerConfidence(left: Confidence, right: Confidence): Confidence {
  return rank[left] >= rank[right] ? left : right;
}

export function scopeKey(scope: ClassScope): string {
  return JSON.stringify(scope.scope === "global" ? ["global"] : ["module", scope.file]);
}

export function symbolScope(symbol: ClassSymbol): ClassScope {
  return symbol.scope === "global" ? { scope: "global" } : { scope: "module", file: symbol.file };
}

/** Unknown imports affect globals and named candidate modules, never arbitrary modules. */
export function createScopeConfidence(
  input: AnalysisInput,
  imports: readonly StyleImportReference[],
  warnings: readonly AnalysisWarning[],
): { readonly assess: (scope: ClassScope) => Assessment; readonly partial: boolean } {
  const scopes = new Map<string, ClassScope>();
  const coverage = new Map<string, StyleCoverage[]>();
  const globalFiles = new Set<ProjectPath>();
  const addScope = (scope: ClassScope): void => { scopes.set(scopeKey(scope), scope); };
  for (const entry of input.styles.coverage) {
    const scope: ClassScope = entry.scope === "global" ? { scope: "global" } : { scope: "module", file: entry.file };
    addScope(scope);
    const key = JSON.stringify([entry.scope, entry.file]);
    const entries = coverage.get(key) ?? [];
    entries.push(entry);
    coverage.set(key, entries);
    if (entry.scope === "global") globalFiles.add(entry.file);
  }
  for (const definition of input.styles.definitions) {
    addScope(symbolScope(definition.symbol));
    if (definition.symbol.scope === "global") globalFiles.add(definition.location.file);
  }
  for (const reference of imports) {
    if (reference.status !== "resolved") continue;
    addScope(reference.scope === "global" ? { scope: "global" } : { scope: "module", file: reference.target });
    if (reference.scope === "global") globalFiles.add(reference.target);
  }
  for (const usage of input.jsx.usages) {
    if (usage.reference.scope === "global") addScope({ scope: "global" });
    else if (usage.reference.import.status === "resolved") {
      addScope({ scope: "module", file: usage.reference.import.target });
    }
  }

  const cache = new Map<string, Assessment>();
  const assess = (scope: ClassScope): Assessment => {
    const cached = cache.get(scopeKey(scope));
    if (cached) return cached;
    let confidence: Confidence = "high";
    const reasons = new Set<string>();
    const limit = (level: Confidence, reason: string): void => {
      confidence = lowerConfidence(confidence, level);
      reasons.add(reason);
    };
    const checkFile = (file: ProjectPath, kind: "global" | "module"): void => {
      const entries = coverage.get(JSON.stringify([kind, file]));
      if (!entries) limit("low", `couverture ${kind} inconnue pour « ${file} »`);
      for (const entry of entries ?? []) {
        if (entry.status === "partial") limit("medium", `analyse ${kind} partielle de « ${file} »`);
        if (entry.status === "unreadable") limit("low", `fichier ${kind} illisible « ${file} »`);
      }
    };
    if (scope.scope === "module") checkFile(scope.file, "module");
    else {
      if (globalFiles.size === 0) limit("low", "couverture des styles globaux inconnue");
      for (const file of globalFiles) checkFile(file, "global");
    }
    for (const warning of warnings) {
      if (warning.affectedScopes.some((affected) => affected.scope === "project" ||
        (affected.scope === "global" && scope.scope === "global") ||
        (affected.scope === "module" && scope.scope === "module" && affected.file === scope.file))) {
        limit("low", `${warning.code} : ${warning.reason}`);
      }
    }
    for (const reference of imports) {
      if (reference.status === "unknown" &&
        (scope.scope === "global" || reference.candidates.includes(scope.file))) {
        limit("low", `import non résolu « ${reference.specifier} » : ${reference.reason}`);
      }
    }
    for (const usage of input.jsx.usages) {
      const reference = usage.reference;
      if (scope.scope === "module" && reference.scope === "module" && reference.import.status === "resolved" &&
        reference.import.target === scope.file && reference.import.scope !== "module") {
        limit("low", `l’import « ${reference.import.specifier} » est global ; ses exports locaux sont inconnus`);
      }
    }
    const result = { confidence, reasons: [...reasons].sort(compareText) };
    cache.set(scopeKey(scope), result);
    return result;
  };
  const partial = warnings.some((warning) => warning.affectedScopes.length > 0) ||
    imports.some((reference) => reference.status === "unknown") ||
    [...scopes.values()].some((scope) => assess(scope).confidence !== "high");
  return { assess, partial };
}
