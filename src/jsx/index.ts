import ts from "typescript";
import type {
  AnalysisWarning, ClassNamePattern, ClassUsage, JsxAnalysis, JsxAnalysisInput,
  ReactSource, SourceLocation, StyleImportReference, UsageReference,
} from "../contracts.js";
import { compareLocations, compareText, sourceLocation } from "../conventions.js";
import { literalParts, splitClassTokens, templateParts } from "./patterns.js";

/** Collect imports plus static/dynamic class usages without executing application code. */
export type AnalyzeJsx = (input: JsxAnalysisInput) => Promise<JsxAnalysis>;

type Binding =
  | { readonly kind: "helper"; readonly namespace: boolean; readonly namedClsx: boolean }
  | { readonly kind: "style"; readonly reference: UsageReference; readonly name?: string };

const globalReference: UsageReference = { scope: "global" };
const unknownPattern: ClassNamePattern = { parts: [{ kind: "unknown" }] };

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) expression = expression.expression;
  return expression;
}

/** The host deliberately has no filesystem or module loading capabilities. */
function createProgram(sources: readonly ReactSource[]) {
  const files = new Map(sources.map((source) => {
    const file = ts.createSourceFile(
      `/${source.file}`, source.content, ts.ScriptTarget.Latest, true,
      source.syntax === "js" || source.syntax === "jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.TSX,
    );
    return [file.fileName, file] as const;
  }));
  const host: ts.CompilerHost = {
    getSourceFile: (name) => files.get(name),
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name)?.text,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  return ts.createProgram([...files.keys()], {
    allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
  }, host);
}

export const analyzeJsx: AnalyzeJsx = async ({ sources, resolveStyleImport }) => {
  const orderedSources = [...sources].sort((a, b) => compareText(a.file, b.file));
  const program = createProgram(orderedSources);
  const checker = program.getTypeChecker();
  const imports: StyleImportReference[] = [];
  const usages: ClassUsage[] = [];
  const warnings: AnalysisWarning[] = [];

  for (const source of orderedSources) {
    const parsed = program.getSourceFile(`/${source.file}`);
    if (!parsed) continue;
    const file: ts.SourceFile = parsed;
    const bindings = new Map<ts.Symbol, Binding>();
    const visited = new Set<ts.Expression>();
    const locationAt = (offset: number): SourceLocation => {
      const { line, character } = file.getLineAndCharacterOfPosition(offset);
      return sourceLocation(source.file, line + 1, character + 1);
    };
    const location = (node: ts.Node) => locationAt(node.getStart(file));
    const bind = (name: ts.Identifier, binding: Binding) => {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) bindings.set(symbol, binding);
    };
    const bindingOf = (expression: ts.Expression): Binding | undefined => {
      const node = unwrap(expression);
      if (!ts.isIdentifier(node)) return undefined;
      const symbol = checker.getSymbolAtLocation(node);
      return symbol ? bindings.get(symbol) : undefined;
    };

    for (const diagnostic of program.getSyntacticDiagnostics(file)) {
      warnings.push({
        stage: "jsx", code: "jsx-parse-error",
        reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        location: locationAt(diagnostic.start ?? 0), affectedScopes: [{ scope: "project" }],
      });
    }

    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      const named = clause?.namedBindings;
      if (/\.(?:css|scss|sass)(?:[?#].*)?$/i.test(specifier)) {
        const names: { identifier: ts.Identifier; name?: string }[] = [];
        if (clause?.name) names.push({ identifier: clause.name });
        if (named && ts.isNamespaceImport(named)) names.push({ identifier: named.name });
        if (named && ts.isNamedImports(named)) {
          for (const item of named.elements) {
            if (item.isTypeOnly) continue;
            const imported = (item.propertyName ?? item.name).text;
            names.push(imported === "default"
              ? { identifier: item.name }
              : { identifier: item.name, name: imported });
          }
        }
        // Even an unused or side-effect import must remain visible to matching.
        if (!clause || (names.length === 0 && named && ts.isNamedImports(named) && named.elements.length === 0)) {
          imports.push(await resolveStyleImport({ specifier, location: location(statement) }));
        } else {
          for (const item of names) {
            const resolved = await resolveStyleImport({
              specifier, binding: item.identifier.text, location: location(statement),
            });
            imports.push(resolved);
            const reference: UsageReference = resolved.status === "resolved" && resolved.scope === "global"
              ? globalReference : { scope: "module", import: resolved };
            bind(item.identifier, { kind: "style", reference, ...(item.name === undefined ? {} : { name: item.name }) });
          }
        }
      } else if (specifier === "clsx" || specifier === "classnames") {
        const helper = { kind: "helper", namespace: false, namedClsx: specifier === "clsx" } as const;
        if (clause?.name) bind(clause.name, helper);
        if (named && ts.isNamespaceImport(named)) bind(named.name, { ...helper, namespace: true });
        if (named && ts.isNamedImports(named)) {
          for (const item of named.elements) {
            const imported = (item.propertyName ?? item.name).text;
            if (!item.isTypeOnly && (imported === "default" || (specifier === "clsx" && imported === "clsx"))) {
              bind(item.name, helper);
            }
          }
        }
      }
    }

    function isHelper(call: ts.CallExpression): boolean {
      const callee = unwrap(call.expression);
      const binding = bindingOf(callee);
      if (binding?.kind === "helper" && !binding.namespace) return true;
      if (ts.isPropertyAccessExpression(callee)) {
        const namespace = bindingOf(callee.expression);
        return namespace?.kind === "helper" && namespace.namespace &&
          (callee.name.text === "default" || (namespace.namedClsx && callee.name.text === "clsx"));
      }
      return false;
    }

    function emitDynamic(
      node: ts.Expression, reference = globalReference, pattern = unknownPattern,
      reason = "Class name depends on a runtime expression.", offset = node.getStart(file),
    ) {
      usages.push({
        kind: "dynamic", expression: node.getText(file), reference, pattern,
        candidates: [], reason, location: locationAt(offset),
      });
    }

    function emitTokens(node: ts.StringLiteralLike | ts.TemplateExpression) {
      const pieces = ts.isTemplateExpression(node) ? templateParts(node, file) : literalParts(node, file);
      for (const token of splitClassTokens(pieces)) {
        const [first, ...rest] = token.parts;
        if (!first) continue;
        const pattern: ClassNamePattern = { parts: [first, ...rest] };
        if (token.parts.every((part) => part.kind === "literal")) {
          usages.push({
            kind: "static", name: token.parts.map((part) => part.kind === "literal" ? part.value : "").join(""),
            reference: globalReference, location: locationAt(token.offset),
          });
        } else if (token.parts.length === 1 && token.expression && emitModule(token.expression)) {
          // An isolated `${styles.title}` keeps the module identity, not a global wildcard.
          visited.add(unwrap(token.expression));
        } else {
          emitDynamic(node, globalReference, pattern, "Class name contains a template interpolation.", token.offset);
        }
      }
    }

    function emitModuleKey(key: ts.Expression, node: ts.Expression, reference: UsageReference) {
      key = unwrap(key);
      if (ts.isStringLiteralLike(key)) {
        usages.push({ kind: "static", name: key.text, reference, location: location(node) });
      } else if (ts.isConditionalExpression(key)) {
        emitModuleKey(key.whenTrue, node, reference);
        emitModuleKey(key.whenFalse, node, reference);
      } else if (ts.isTemplateExpression(key)) {
        // Module keys are a single property name; whitespace does not split them.
        const parts = templateParts(key, file)
          .filter((part) => part.kind !== "literal" || part.value !== "")
          .map((part) => part.kind === "literal"
            ? { kind: "literal" as const, value: part.value } : { kind: "unknown" as const });
        const [first, ...rest] = parts;
        emitDynamic(node, reference, first ? { parts: [first, ...rest] } : unknownPattern,
          "CSS Module key depends on a runtime expression.");
      } else {
        emitDynamic(node, reference, unknownPattern, "CSS Module key depends on a runtime expression.");
      }
    }

    function emitModule(expression: ts.Expression): boolean {
      const node = unwrap(expression);
      const direct = bindingOf(node);
      if (direct?.kind === "style") {
        if (direct.name !== undefined) {
          usages.push({ kind: "static", name: direct.name, reference: direct.reference, location: location(node) });
        } else {
          emitDynamic(node, direct.reference, unknownPattern, "CSS Module object is used without a known key.");
        }
        return true;
      }
      if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
      const binding = bindingOf(node.expression);
      if (binding?.kind !== "style" || binding.name !== undefined) return false;
      if (ts.isPropertyAccessExpression(node)) {
        usages.push({ kind: "static", name: node.name.text, reference: binding.reference, location: location(node) });
      } else if (node.argumentExpression) {
        emitModuleKey(node.argumentExpression, node, binding.reference);
      } else {
        emitDynamic(node, binding.reference);
      }
      return true;
    }

    function emitObject(object: ts.ObjectLiteralExpression) {
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          emitDynamic(property.expression, globalReference, unknownPattern, "Spread object keys are unknown at analysis time.");
          continue;
        }
        const key = property.name;
        if (!key) continue;
        if (ts.isComputedPropertyName(key)) {
          emitExpression(key.expression);
        } else if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) {
          if (ts.isStringLiteralLike(key)) emitTokens(key);
          else usages.push({ kind: "static", name: key.text, reference: globalReference, location: location(key) });
        }
        // The condition/value is not a class context: { active: "arbitrary text" }.
      }
    }

    function emitExpression(expression: ts.Expression, helperArgument = false) {
      const node = unwrap(expression);
      if (visited.has(node)) return;
      visited.add(node);
      if (emitModule(node)) return;
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        emitTokens(node);
      } else if (ts.isConditionalExpression(node)) {
        emitExpression(node.whenTrue, helperArgument);
        emitExpression(node.whenFalse, helperArgument);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        emitExpression(node.right, helperArgument);
      } else if (ts.isBinaryExpression(node) && (
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      )) {
        emitExpression(node.left, helperArgument);
        emitExpression(node.right, helperArgument);
      } else if (ts.isCallExpression(node) && isHelper(node)) {
        for (const argument of node.arguments) emitExpression(argument, true);
      } else if (helperArgument && ts.isArrayLiteralExpression(node)) {
        for (const item of node.elements) {
          if (!ts.isOmittedExpression(item)) emitExpression(item, true);
        }
      } else if (helperArgument && ts.isObjectLiteralExpression(node)) {
        emitObject(node);
      } else if (helperArgument && ts.isSpreadElement(node)) {
        emitExpression(node.expression, true);
      } else if (
        node.kind !== ts.SyntaxKind.TrueKeyword && node.kind !== ts.SyntaxKind.FalseKeyword &&
        node.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(node) && node.text === "undefined")
      ) {
        emitDynamic(node);
      }
    }

    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isJsxAttribute(node) && node.name.getText(file) === "className" && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) emitExpression(node.initializer);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) emitExpression(node.initializer.expression);
      } else if (ts.isCallExpression(node) && isHelper(node)) {
        emitExpression(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  imports.sort((a, b) => compareLocations(a.location, b.location) || compareText(a.specifier, b.specifier));
  usages.sort((a, b) => compareLocations(a.location, b.location) ||
    compareText(a.kind === "static" ? a.name : a.expression, b.kind === "static" ? b.name : b.expression));
  warnings.sort((a, b) => compareLocations(a.location, b.location) || compareText(a.stage, b.stage) ||
    compareText(a.code, b.code) || compareText(a.reason, b.reason));
  return { imports, usages, warnings };
};
