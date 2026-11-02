/** Paths in exchanged data are relative to the project root and use forward slashes. */
declare const projectPathBrand: unique symbol;
export type ProjectPath = string & { readonly [projectPathBrand]: true };

export interface SourceLocation {
  readonly file: ProjectPath;
  /** One-based. */
  readonly line: number;
  /** One-based, when the parser can provide it. */
  readonly column?: number;
}

export type StyleSyntax = "css" | "scss" | "sass";
export type StyleScope = "global" | "module";
export type ReactSyntax = "js" | "jsx" | "ts" | "tsx";
export type Confidence = "high" | "medium" | "low";
export type AnalysisStage = "discovery" | "styles" | "jsx";

export type AnalysisScope =
  | { readonly scope: "global" }
  | { readonly scope: "module"; readonly file: ProjectPath }
  | { readonly scope: "project" };

export type ClassPatternPart =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "unknown" };

/** Concatenated parts; an unknown part matches zero or more characters within one class name. */
export interface ClassNamePattern {
  readonly parts: readonly [ClassPatternPart, ...ClassPatternPart[]];
}

export type ExternalGlobalClass =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "pattern"; readonly pattern: ClassNamePattern };

export interface ProjectConfig {
  /** Absolute host path; never serialized in an analysis report. */
  readonly rootDir: string;
  /** Root-relative glob patterns. Discovery owns defaults and configuration loading. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Normalized root-relative path mappings; discovery defines the declarative config format. */
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly externalGlobals: readonly ExternalGlobalClass[];
}

export interface DiscoveryOptions {
  readonly rootDir: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface StyleFile {
  readonly file: ProjectPath;
  readonly syntax: StyleSyntax;
  readonly scope: StyleScope;
}

export interface StyleSource extends StyleFile {
  readonly content: string;
}

export interface ReactSource {
  readonly file: ProjectPath;
  readonly syntax: ReactSyntax;
  readonly content: string;
}

export interface AnalysisWarning {
  readonly stage: AnalysisStage;
  /** Stable machine-readable code, e.g. unsupported-syntax. */
  readonly code: string;
  readonly reason: string;
  readonly location: SourceLocation;
  /** Empty for informational warnings; project means the affected scope is unknown. */
  readonly affectedScopes: readonly AnalysisScope[];
}

export interface DiscoveredProject {
  readonly config: ProjectConfig;
  readonly styles: readonly StyleSource[];
  readonly react: readonly ReactSource[];
  readonly warnings: readonly AnalysisWarning[];
}

/** A module class is identified by BOTH its module file and its unescaped name. */
export type ClassSymbol =
  | { readonly scope: "global"; readonly name: string }
  | { readonly scope: "module"; readonly file: ProjectPath; readonly name: string };

export interface ClassDefinition {
  readonly symbol: ClassSymbol;
  readonly selector: string;
  readonly location: SourceLocation;
}

export interface StyleImportRequest {
  /** Original import specifier, before resolution (including aliases). */
  readonly specifier: string;
  /** Absent for a side-effect import. */
  readonly binding?: string;
  /** location.file is the importer, not the imported stylesheet. */
  readonly location: SourceLocation;
}

export type StyleImportReference = StyleImportRequest &
  (
    | { readonly status: "resolved"; readonly target: ProjectPath; readonly scope: StyleScope }
    | {
        readonly status: "unknown";
        readonly reason: string;
        readonly candidates: readonly ProjectPath[];
      }
  );

/** Bound to discovery/configuration; JSX tests can inject an in-memory substitute. */
export type ResolveStyleImport = (request: StyleImportRequest) => Promise<StyleImportReference>;

export type UsageReference =
  | { readonly scope: "global" }
  | { readonly scope: "module"; readonly import: StyleImportReference };

export type ClassUsage = {
  readonly location: SourceLocation;
  readonly reference: UsageReference;
} &
  (
    | { readonly kind: "static"; readonly name: string }
    | {
        readonly kind: "dynamic";
        readonly expression: string;
        /** Known fragments survive extraction; matching never needs to reparse JavaScript. */
        readonly pattern: ClassNamePattern;
        /** Possible names only; an empty list leaves possibilities to the pattern. */
        readonly candidates: readonly string[];
        readonly reason: string;
      }
  );

export interface StyleAnalysis {
  readonly definitions: readonly ClassDefinition[];
  /** Includes empty, partially parsed and unreadable stylesheets. Missing entries mean unknown. */
  readonly coverage: readonly StyleCoverage[];
  readonly warnings: readonly AnalysisWarning[];
}

export interface StyleCoverage {
  readonly file: ProjectPath;
  /** A module file can additionally have a global coverage entry for :global definitions. */
  readonly scope: StyleScope;
  readonly status: "complete" | "partial" | "unreadable";
}

export interface JsxAnalysisInput {
  readonly sources: readonly ReactSource[];
  readonly resolveStyleImport: ResolveStyleImport;
}

export interface JsxAnalysis {
  readonly imports: readonly StyleImportReference[];
  readonly usages: readonly ClassUsage[];
  readonly warnings: readonly AnalysisWarning[];
}

export interface AnalysisInput {
  readonly externalGlobals: readonly ExternalGlobalClass[];
  readonly styles: StyleAnalysis;
  readonly jsx: JsxAnalysis;
  /** Discovery warnings; style/JSX warnings remain in their corresponding result. */
  readonly warnings: readonly AnalysisWarning[];
}

export type DiagnosticCategory =
  | "unused-class"
  | "undefined-class"
  | "dynamic-usage"
  | "unresolved-import"
  | "analysis-warning";

export interface DiagnosticCandidate {
  readonly symbol: ClassSymbol;
  readonly location: SourceLocation;
  readonly confidence: Confidence;
  readonly reason: string;
}

export interface Diagnostic {
  readonly category: DiagnosticCategory;
  readonly confidence: Confidence;
  readonly reason: string;
  readonly location: SourceLocation;
  readonly symbol?: ClassSymbol;
  readonly candidates: readonly DiagnosticCandidate[];
}

export interface AnalysisReport {
  readonly schemaVersion: 1;
  readonly completeness: "complete" | "partial";
  readonly diagnostics: readonly Diagnostic[];
  /** All discovery, style and JSX warnings, kept even if also rendered as diagnostics. */
  readonly warnings: readonly AnalysisWarning[];
}

export type ReportFormat = "terminal" | "json" | "markdown";

export type ScanOutcome =
  | { readonly status: "success"; readonly report: AnalysisReport }
  | { readonly status: "error"; readonly reason: string; readonly location?: SourceLocation };

export interface ExitCodeOptions {
  readonly failOnMissing: boolean;
}

export type ExitCode = 0 | 1 | 2;
