import { createRequire } from "node:module";
import { posix } from "node:path";
import postcss from "postcss";
import type { ChildNode, Container, Root, Rule, Source } from "postcss";
import type {
  AnalysisScope, AnalysisWarning, ClassDefinition, SourceLocation, StyleAnalysis,
  ProjectPath, StyleCoverage, StyleScope, StyleSource, StyleSyntax,
} from "../contracts.js";
import { classSymbolKey, compareLocations, compareText, projectPath } from "../conventions.js";
import { Selectors } from "./selectors.js";
import type { SelectorContext } from "./selectors.js";

export type AnalyzeStyles = (sources: readonly StyleSource[]) => Promise<StyleAnalysis>;

// sass-parser 0.5.3 ships declarations under dist/lib but its exports point at
// dist/types. Isolate that packaging defect here, using only its PostCSS surface.
const sassParsers = createRequire(import.meta.url)("sass-parser") as Record<StyleSyntax, {
  parse(content: string): Root;
}>;
type SassRule = Rule & { readonly parsedSelector: { readonly source: Source } };

const uncertainAtRules = new Set([
  "mixin", "include", "function", "if", "else", "each", "for", "while", "extend",
  "at-root", "content", "use", "forward", "import",
]);

/** Parse source text only: no compiler, importer, project configuration or file access. */
export const analyzeStyles: AnalyzeStyles = async (sources) => {
  const definitions: ClassDefinition[] = [];
  const warnings: AnalysisWarning[] = [];
  const coverage: StyleCoverage[] = [];
  const scopesByFile = new Map(sources.map(source => [source.file, source.scope]));
  for (const source of [...sources].sort((a, b) => compareText(a.file, b.file))) {
    const result = analyzeFile(source, scopesByFile);
    definitions.push(...result.definitions);
    warnings.push(...result.warnings);
    coverage.push(...result.coverage);
  }
  definitions.sort((a, b) => compareLocations(a.location, b.location) || compareText(classSymbolKey(a.symbol), classSymbolKey(b.symbol)));
  warnings.sort((a, b) => compareLocations(a.location, b.location) || compareText(a.stage, b.stage) || compareText(a.code, b.code) || compareText(a.reason, b.reason));
  coverage.sort((a, b) => compareText(a.file, b.file) || compareText(a.scope, b.scope));
  return { definitions, coverage, warnings };
};

function analyzeFile(source: StyleSource, scopesByFile: ReadonlyMap<ProjectPath, StyleScope>): StyleAnalysis {
  const definitions: ClassDefinition[] = [];
  const warnings: AnalysisWarning[] = [];
  const statuses = new Map<StyleScope, StyleCoverage["status"]>([[source.scope, "complete"]]);
  const locationAt = createLocator(source);
  const selectors = new Selectors(locationAt);
  const scopeReference = (scope: StyleScope): AnalysisScope => scope === "global"
    ? { scope: "global" }
    : { scope: "module", file: source.file };
  const warn = (code: string, reason: string, location: SourceLocation, scopes: readonly StyleScope[], additionalScopes: readonly AnalysisScope[] = []): void => {
    const unique = [...new Set(scopes)].sort(compareText);
    for (const scope of unique) statuses.set(scope, "partial");
    const affectedScopes = new Map([...unique.map(scopeReference), ...additionalScopes].map(scope => [JSON.stringify(scope), scope]));
    warnings.push({ stage: "styles", code, reason, location, affectedScopes: [...affectedScopes.values()] });
  };
  const scopesIn = (text: string, context: SelectorContext): StyleScope[] => {
    const scopes = [context.scope];
    if (text.includes(":global")) scopes.push("global");
    if (text.includes(":local")) scopes.push("module");
    for (const scope of scopes) if (!statuses.has(scope)) statuses.set(scope, "complete");
    return scopes;
  };
  const rawSelector = (node: Rule): { text: string; offset: number } => {
    const span = source.syntax === "css" ? node.source : (node as SassRule).parsedSelector.source;
    const offset = span?.start?.offset ?? 0;
    return {
      offset,
      // Sass normalizes whitespace when serializing selectors. Its original span
      // preserves multiline lists, CRLF, escapes and UTF-16 source positions.
      text: source.syntax === "css" ? (node.raws.selector?.raw ?? node.selector)
        : source.content.slice(offset, span?.end?.offset),
    };
  };
  const uncertainScopes = (node: Rule, parents: ReturnType<Selectors["parse"]>, context: SelectorContext, scopes: StyleScope[]): StyleScope[] => {
    const affected = [...scopes, ...selectors.scopes(parents)];
    // Discarding a rule also discards its descendants, which may escape its scope.
    node.walkRules((child) => { affected.push(...scopesIn(rawSelector(child).text, context)); });
    return affected;
  };

  let root: Root;
  try {
    root = source.syntax === "css" ? postcss.parse(source.content) : sassParsers[source.syntax].parse(source.content);
  } catch (error) {
    const message = errorMessage(error);
    const location = syntaxErrorLocation(error, message, source, locationAt);
    // A broken parse cannot establish whether a scope escape occurs in the lost tree.
    const scopes: StyleScope[] = source.scope === "module" || /:local\b/.test(source.content)
      ? ["global", "module"] : ["global"];
    warn("style-syntax-error", message.split("\n")[0] ?? message, location, scopes);
    for (const scope of scopes) statuses.set(scope, "unreadable");
    return { definitions, warnings, coverage: toCoverage() };
  }

  const visit = (container: Container, parents: ReturnType<Selectors["parse"]>, context: SelectorContext): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === "atrule") {
        const name = node.name.toLowerCase();
        if (source.syntax !== "css" && uncertainAtRules.has(name)) {
          warn("unsupported-sass-construction", `Sass @${name} is not evaluated; generated or conditional classes remain unknown.`, nodeLocation(node), ["global", "module"]);
          continue;
        }
        if (source.syntax !== "css" && (name.includes("#{") || node.params.includes("#{"))) {
          warn("unsupported-sass-construction", "Sass at-rule interpolation is not evaluated.", nodeLocation(node), ["global", "module"]);
          continue;
        }
        // Frames are not selectors that define classes; at-rule parameters aren't either.
        if (/^(?:-\w+-)?keyframes$/.test(name)) continue;
        if (node.nodes) visit(node, parents, context);
      } else if (node.type === "rule") {
        const { text, offset } = rawSelector(node);
        const scopes = scopesIn(text, context);
        const scopeBlock = /^:(global|local)$/.exec(text.replace(/\/\*[\s\S]*?\*\//g, "").trim());
        if (scopeBlock) {
          const scope = scopeBlock[1] === "global" ? "global" : "module";
          visit(node, parents, { scope, override: scope });
          continue;
        }
        // Drop the whole uncertain rule, including descendants that depend on its selector.
        if (text.includes("#{")) {
          warn("dynamic-style-selector", "Sass selector interpolation cannot be resolved statically.", locationAt(offset + text.indexOf("#{")), uncertainScopes(node, parents, context, scopes));
          continue;
        }
        try {
          const parsed = selectors.parse(text, offset, context);
          let placeholder = false;
          for (const selector of parsed) selector.walkTags((tag) => { if (tag.value.startsWith("%")) placeholder = true; });
          if (placeholder || text.trimStart().startsWith("%")) {
            warn("unsupported-sass-construction", "Sass placeholders and their extensions are not evaluated.", locationAt(offset), uncertainScopes(node, parents, context, scopes));
            continue;
          }
          const resolved = selectors.resolve(parsed, parents);
          const found = selectors.definitions(resolved);
          for (const definition of found) if (!statuses.has(definition.symbol.scope)) statuses.set(definition.symbol.scope, "complete");
          definitions.push(...found);
          visit(node, resolved, context);
        } catch (error) {
          warn("unsupported-style-selector", errorMessage(error), locationAt(offset), uncertainScopes(node, parents, context, scopes));
        }
      } else if (node.type === "decl" && node.prop.toLowerCase() === "composes") {
        const scopes = selectors.scopes(parents);
        warn("unresolved-css-composition", "CSS Modules composition dependencies are not resolved; classes in the affected scopes may be used by this composition.",
          nodeLocation(node), scopes.length > 0 ? scopes : [context.scope], compositionTargetScopes(node.value, source.file, scopesByFile));
      }
    }
  };
  visit(root, [], { scope: source.scope });
  return { definitions, warnings, coverage: toCoverage() };

  function toCoverage(): StyleCoverage[] {
    return [...statuses].map(([scope, status]) => ({ file: source.file, scope, status }));
  }
  function nodeLocation(node: ChildNode): SourceLocation {
    return locationAt(node.source?.start?.offset ?? 0);
  }
}

/** Preserve uncertainty without guessing names or evaluating Sass expressions. */
function compositionTargetScopes(value: string, file: ProjectPath, scopesByFile: ReadonlyMap<ProjectPath, StyleScope>): readonly AnalysisScope[] {
  // Remove comments outside quoted paths before identifying the optional origin.
  const text = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g,
    token => token.startsWith("/*") ? " " : token).trim();
  const origin = /\bfrom\s+(?:"([^"\\]*)"|'([^'\\]*)'|(global))\s*$/u.exec(text);
  if (origin?.[3]) return [{ scope: "global" }];
  const specifier = origin?.[1] ?? origin?.[2];
  if (specifier && !/[?#$]/u.test(specifier) && (specifier.startsWith("./") || specifier.startsWith("../")) && /\.(?:css|scss|sass)$/u.test(specifier)) {
    try {
      const target = projectPath(posix.normalize(posix.join(posix.dirname(file), specifier)));
      const scopes: AnalysisScope[] = [{ scope: "module", file: target }];
      // A nominally global file can also declare explicit :local classes.
      if (scopesByFile.get(target) === "global") scopes.push({ scope: "global" });
      return scopes;
    } catch {
      // An origin outside the root cannot be assigned to a known project scope.
    }
  }
  // Plain local names need no additional scope. Unknown origins and dynamic
  // values may refer to any module, so the report must expose that uncertainty.
  return /\bfrom\b|["'$#()\\]/u.test(text) ? [{ scope: "project" }] : [];
}

function createLocator(source: StyleSource): (offset: number) => SourceLocation {
  const starts = [0];
  for (let index = 0; index < source.content.length; index++) {
    const char = source.content[index];
    if (char === "\n" || (char === "\r" && source.content[index + 1] !== "\n")) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { file: source.file, line: low + 1, column: offset - starts[low]! + 1 };
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syntaxErrorLocation(error: unknown, message: string, source: StyleSource, locate: (offset: number) => SourceLocation): SourceLocation {
  if (error instanceof postcss.CssSyntaxError && error.line && error.column) {
    return { file: source.file, line: error.line, column: error.column };
  }
  // sass-parser currently exposes Dart format errors rather than Sass JS exceptions.
  const match = /\n\s*- (\d+):(\d+)\s+root stylesheet\s*$/.exec(message);
  return match ? { file: source.file, line: Number(match[1]), column: Number(match[2]) } : locate(0);
}
