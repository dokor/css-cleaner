import assert from "node:assert/strict";
import test from "node:test";
import { exampleInput, exampleProject, exampleReport, footerButton, headerButton } from "../examples/contract.js";
import type { AnalyzeJsx, AnalyzeStyles, CreateStyleImportResolver, DiscoverProject, MatchClasses, RenderReport } from "../src/index.js";
import { classSymbolKey } from "../src/index.js";

test("two homonymous module classes keep distinct identities in the typed contract", () => {
  const definitions = exampleInput.styles.definitions.filter((entry) => entry.symbol.name === "button");
  assert.equal(definitions.length, 2);
  const bySymbol = new Map(definitions.map((entry) => [classSymbolKey(entry.symbol), entry]));
  assert.equal(bySymbol.size, 2);
  assert.equal(bySymbol.get(classSymbolKey(headerButton))?.location.file, "src/Header.module.scss");
  assert.equal(bySymbol.get(classSymbolKey(footerButton))?.location.file, "src/Footer.module.sass");
  const usage = exampleInput.jsx.usages.find((entry) => entry.kind === "static" && entry.name === "button");
  assert.equal(usage?.reference.scope, "module");
  if (usage?.reference.scope !== "module") assert.fail("Expected a module reference");
  assert.equal(usage.reference.import.status, "resolved");
  if (usage.reference.import.status !== "resolved") assert.fail("Expected a resolved import");
  assert.equal(usage.reference.import.target, headerButton.file);
  const diagnostic = exampleReport.diagnostics[2];
  assert.ok(diagnostic);
  const candidate = diagnostic.candidates[0];
  assert.ok(candidate);
  assert.equal(classSymbolKey(candidate.symbol), classSymbolKey(headerButton));
  assert.notEqual(classSymbolKey(candidate.symbol), classSymbolKey(footerButton));
});

test("stage contracts can be used independently with in-memory fixtures", async () => {
  // These adapters return fixtures; they do not pretend to parse or match anything.
  const discoverProject: DiscoverProject = async () => exampleProject;
  const createStyleImportResolver: CreateStyleImportResolver = () => async (request) => ({
    ...request, status: "resolved", target: headerButton.file, scope: "module",
  });
  const analyzeStyles: AnalyzeStyles = async () => exampleInput.styles;
  const analyzeJsx: AnalyzeJsx = async (input) => {
    const [request] = exampleInput.jsx.imports;
    assert.ok(request);
    const resolved = await input.resolveStyleImport(request);
    assert.equal(resolved.status, "resolved");
    return exampleInput.jsx;
  };
  const matchClasses: MatchClasses = () => exampleReport;
  const renderReport: RenderReport = (report) => JSON.stringify(report);
  const project = await discoverProject({ rootDir: exampleProject.config.rootDir });
  const input = {
    externalGlobals: project.config.externalGlobals,
    styles: await analyzeStyles(project.styles),
    jsx: await analyzeJsx({ sources: project.react, resolveStyleImport: createStyleImportResolver(project) }),
    warnings: project.warnings,
  };
  const report = matchClasses(input);
  assert.deepEqual(JSON.parse(renderReport(report, "json")), exampleReport);
  assert.equal(input.jsx.usages.filter((entry) => entry.kind === "dynamic").length, 2);
  assert.ok(input.jsx.imports.some((entry) => entry.status === "unknown"));
  assert.equal(report.warnings.length, 1);
});

test("patterns and partial analysis survive the shared contract without reparsing expressions", () => {
  const usage = exampleInput.jsx.usages.find((entry) => entry.kind === "dynamic" && entry.reference.scope === "global");
  assert.ok(usage?.kind === "dynamic");
  assert.deepEqual(usage.pattern.parts, [{ kind: "literal", value: "button--" }, { kind: "unknown" }]);
  assert.equal(exampleInput.styles.coverage.length, exampleProject.styles.length);
  assert.deepEqual(exampleInput.externalGlobals, exampleProject.config.externalGlobals);
  assert.equal(exampleReport.completeness, "partial");
  assert.deepEqual(exampleReport.warnings[0]?.affectedScopes, [{ scope: "project" }]);
  for (const category of ["undefined-class", "unused-class", "dynamic-usage"]) {
    assert.ok(exampleReport.diagnostics.some((diagnostic) => diagnostic.category === category));
  }
});
