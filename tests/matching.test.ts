import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnalysisInput, AnalysisReport, AnalysisWarning, ClassDefinition, ClassNamePattern, ClassUsage,
  DiagnosticCategory, ExternalGlobalClass, ProjectPath, StyleCoverage, StyleImportReference, UsageReference,
} from "../src/contracts.js";
import { classSymbolKey, compareDiagnostics, projectPath, sourceLocation } from "../src/conventions.js";
import { matchClasses } from "../src/matching/index.js";

const a = projectPath("src/A.module.scss");
const b = projectPath("src/B.module.sass");
const globalFile = projectPath("src/global.css");
const app = projectPath("src/App.tsx");
const global: UsageReference = { scope: "global" };
const free: ClassNamePattern = { parts: [{ kind: "unknown" }] };
const buttonPattern: ClassNamePattern = { parts: [{ kind: "literal", value: "button--" }, { kind: "unknown" }] };

function moduleImport(file = a): StyleImportReference {
  return { status: "resolved", specifier: `./${file}`, target: file, scope: "module", binding: "styles", location: sourceLocation(app, 1, 1) };
}
function local(file = a): UsageReference { return { scope: "module", import: moduleImport(file) }; }
function moduleClass(name: string, file = a, line = 1): ClassDefinition {
  return { symbol: { scope: "module", file, name }, selector: `.${name}`, location: sourceLocation(file, line, 1) };
}
function globalClass(name: string, file = globalFile, line = 1): ClassDefinition {
  return { symbol: { scope: "global", name }, selector: `.${name}`, location: sourceLocation(file, line, 1) };
}
function staticUsage(name: string, reference = local(), line = 10): ClassUsage {
  return { kind: "static", name, reference, location: sourceLocation(app, line, 4) };
}
function dynamicUsage(pattern = buttonPattern, reference = local(), line = 20): Extract<ClassUsage, { kind: "dynamic" }> {
  return { kind: "dynamic", expression: "styles[`button--${variant}`]", pattern, reference,
    reason: "La variante dépend d’une prop.", candidates: [], location: sourceLocation(app, line, 8) };
}
function unknownImport(candidates: readonly ProjectPath[] = []): StyleImportReference {
  return { status: "unknown", specifier: "@theme/styles", binding: "theme", candidates,
    reason: "Alias introuvable.", location: sourceLocation(app, 2, 1) };
}
function warning(affectedScopes: AnalysisWarning["affectedScopes"], stage: AnalysisWarning["stage"] = "styles"): AnalysisWarning {
  return { stage, code: "undecidable-selector", reason: "Sélecteur interpolé indécidable.",
    location: sourceLocation(a, 5, 2), affectedScopes };
}
function input(options: {
  readonly definitions?: readonly ClassDefinition[];
  readonly coverage?: readonly StyleCoverage[];
  readonly usages?: readonly ClassUsage[];
  readonly imports?: readonly StyleImportReference[];
  readonly externalGlobals?: readonly ExternalGlobalClass[];
  readonly warnings?: readonly AnalysisWarning[];
  readonly styleWarnings?: readonly AnalysisWarning[];
  readonly jsxWarnings?: readonly AnalysisWarning[];
} = {}): AnalysisInput {
  return {
    styles: { definitions: options.definitions ?? [], warnings: options.styleWarnings ?? [], coverage: options.coverage ?? [
      { file: a, scope: "module", status: "complete" },
      { file: b, scope: "module", status: "complete" },
      { file: globalFile, scope: "global", status: "complete" },
    ] },
    jsx: { imports: options.imports ?? [], usages: options.usages ?? [], warnings: options.jsxWarnings ?? [] },
    externalGlobals: options.externalGlobals ?? [], warnings: options.warnings ?? [],
  };
}
function category(report: AnalysisReport, value: DiagnosticCategory) {
  return report.diagnostics.filter((diagnostic) => diagnostic.category === value);
}

test("matching emits positioned, explained diagnostics at all three confidence levels", () => {
  const missing = staticUsage("missing");
  const dynamic = dynamicUsage();
  const freeUsage = { ...dynamicUsage(free, local(), 30), expression: "styles[key]" };
  const report = matchClasses(input({ definitions: [moduleClass("button--primary"), moduleClass("title", a, 2)],
    usages: [missing, dynamic, freeUsage] }));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.completeness, "complete");
  assert.deepEqual(category(report, "undefined-class"), [{
    category: "undefined-class", confidence: "high", location: missing.location, candidates: [],
    symbol: { scope: "module", file: a, name: "missing" },
    reason: `Aucune définition de « missing » dans le module « ${a} ». Cette portée a été analysée intégralement.`,
  }]);
  const dynamics = category(report, "dynamic-usage");
  assert.deepEqual(dynamics.map((entry) => [entry.location, entry.confidence]), [[dynamic.location, "medium"], [freeUsage.location, "low"]]);
  assert.match(dynamics[0]?.reason ?? "", /La variante dépend d’une prop/);
  assert.match(dynamics[0]?.candidates[0]?.reason ?? "", /Nom compatible avec le motif/);
  assert.equal(dynamics[0]?.candidates[0]?.confidence, "medium");
  const unused = category(report, "unused-class");
  assert.equal(unused.length, 2);
  assert.ok(unused.every((entry) => entry.confidence === "low" && /Usage dynamique compatible/.test(entry.reason)));
  assert.deepEqual(unused.map((entry) => entry.location), [sourceLocation(a, 1, 1), sourceLocation(a, 2, 1)]);
});

test("a module lookup cannot be satisfied by another module or a global homonym", () => {
  const report = matchClasses(input({ definitions: [moduleClass("title", b), globalClass("title"), moduleClass("localOnly")],
    usages: [staticUsage("title"), staticUsage("localOnly", global, 11)] }));
  const missing = category(report, "undefined-class");
  assert.deepEqual(missing.map((entry) => entry.symbol), [
    { scope: "module", file: a, name: "title" }, { scope: "global", name: "localOnly" },
  ]);
  assert.ok(missing.every((entry) => entry.confidence === "high" && entry.candidates.length === 0));
  assert.equal(category(report, "unused-class").length, 3);
  assert.ok(category(report, "unused-class").every((entry) => entry.confidence === "high"));
});

test("a static match uses every declaration of its identity and no homonym", () => {
  const report = matchClasses(input({ definitions: [moduleClass("title"), moduleClass("title", a, 3), moduleClass("title", b), globalClass("page")],
    usages: [staticUsage("title"), staticUsage("page", global)] }));
  assert.deepEqual(category(report, "undefined-class"), []);
  assert.deepEqual(category(report, "unused-class").map((entry) => entry.symbol), [{ scope: "module", file: b, name: "title" }]);
});

for (const reference of [local(), global]) {
  test(`button interpolation proposes only compatible names in ${reference.scope} scope`, () => {
    const report = matchClasses(input({ definitions: [
      moduleClass("button--primary"), moduleClass("button--secondary", a, 2), moduleClass("link--primary", a, 3),
      moduleClass("button--primary", b), globalClass("button--primary"), globalClass("button--secondary", globalFile, 2),
      globalClass("link--primary", globalFile, 3),
    ], usages: [dynamicUsage(buttonPattern, reference)] }));
    const candidates = category(report, "dynamic-usage")[0]?.candidates ?? [];
    assert.deepEqual(candidates.map((entry) => entry.symbol.name), ["button--primary", "button--secondary"]);
    assert.ok(candidates.every((entry) => entry.symbol.scope === reference.scope && entry.confidence === "medium"));
    assert.ok(candidates.every((entry) => entry.symbol.scope !== "module" || entry.symbol.file === a));
    assert.equal(category(report, "undefined-class").length, 0);
    for (const unused of category(report, "unused-class")) {
      const compatible = candidates.some((entry) => classSymbolKey(entry.symbol) === classSymbolKey(unused.symbol!));
      assert.equal(unused.confidence, compatible ? "medium" : "high");
    }
  });
}

test("free module keys protect all exports in that module and preserve an independent module", () => {
  const report = matchClasses(input({ definitions: [moduleClass("title"), moduleClass("button", a, 2), moduleClass("title", b)],
    usages: [{ ...dynamicUsage(free), expression: "styles[key]" }, staticUsage("missing", local(b), 11)] }));
  assert.equal(category(report, "undefined-class")[0]?.confidence, "high");
  assert.deepEqual(category(report, "unused-class").map((entry) => entry.confidence), ["low", "low", "high"]);
  assert.equal(category(report, "dynamic-usage")[0]?.confidence, "low");
  assert.equal(category(report, "dynamic-usage")[0]?.candidates.length, 2);
});

test("dynamic name hints are possibilities, never an exhaustive restriction of the pattern", () => {
  const usage = { ...dynamicUsage(), candidates: ["button--primary", "link--primary"] };
  const report = matchClasses(input({ definitions: [moduleClass("button--primary"), moduleClass("button--secondary", a, 2),
    moduleClass("link--primary", a, 3)], usages: [usage] }));
  assert.deepEqual(category(report, "dynamic-usage")[0]?.candidates.map((entry) => entry.symbol.name), ["button--primary", "button--secondary"]);
  assert.equal(category(report, "unused-class")[1]?.confidence, "medium");
  assert.equal(category(report, "unused-class")[2]?.confidence, "high");
});

test("a dynamic pattern without known definitions still produces a review diagnostic and no missing class", () => {
  const report = matchClasses(input({ usages: [dynamicUsage()] }));
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0]?.category, "dynamic-usage");
  assert.deepEqual(report.diagnostics[0]?.candidates, []);
});

test("unresolved imports keep candidate modules uncertain without satisfying a static lookup", () => {
  const unresolved = unknownImport([a]);
  const reference: UsageReference = { scope: "module", import: unresolved };
  const report = matchClasses(input({ definitions: [moduleClass("title"), moduleClass("other", a, 2), moduleClass("title", b), globalClass("title")],
    imports: [unresolved, unresolved], usages: [staticUsage("title", reference), dynamicUsage(free, reference),
      staticUsage("missing", local(b), 12), staticUsage("missing", global, 13)] }));
  assert.equal(report.completeness, "partial");
  assert.equal(category(report, "unresolved-import").length, 1);
  assert.equal(category(report, "unresolved-import")[0]?.confidence, "low");
  assert.deepEqual(category(report, "unresolved-import")[0]?.location, unresolved.location);
  const missing = category(report, "undefined-class");
  assert.equal(missing[0]?.confidence, "low");
  assert.equal(missing[0]?.symbol, undefined);
  assert.match(missing[0]?.reason ?? "", /n’est pas résolu/);
  assert.deepEqual(missing[0]?.candidates.map((entry) => entry.symbol), [{ scope: "module", file: a, name: "title" }]);
  assert.deepEqual(missing.map((entry) => entry.confidence), ["low", "high", "low"]);
  assert.equal(category(report, "dynamic-usage")[0]?.candidates.length, 2);
  assert.ok(category(report, "dynamic-usage")[0]?.candidates.every((entry) => entry.confidence === "low"));
  assert.deepEqual(category(report, "unused-class").filter((entry) => entry.symbol?.scope === "module")
    .map((entry) => entry.confidence), ["low", "low", "high"]);
});

test("an import with no known origin does not poison unrelated fully analyzed modules", () => {
  const reference: UsageReference = { scope: "module", import: unknownImport() };
  const report = matchClasses(input({ definitions: [moduleClass("unused", b)],
    usages: [staticUsage("missing", reference), staticUsage("missing", local(b), 11)] }));
  assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence), ["low", "high"]);
  assert.equal(category(report, "unused-class")[0]?.confidence, "high");
  assert.equal(category(report, "unresolved-import").length, 1, "imports attached only to usages are also retained");
});

for (const [status, expected] of [["partial", "medium"], ["unreadable", "low"], ["absent", "low"]] as const) {
  test(`${status} module coverage lowers only the affected module`, () => {
    const coverage: StyleCoverage[] = [{ file: b, scope: "module", status: "complete" }, { file: globalFile, scope: "global", status: "complete" }];
    if (status !== "absent") coverage.push({ file: a, scope: "module", status });
    const report = matchClasses(input({ coverage, definitions: [moduleClass("unused"), moduleClass("unused", b)],
      usages: [staticUsage("missing"), staticUsage("missing", local(b), 11), staticUsage("missing", global, 12)] }));
    assert.equal(report.completeness, "partial");
    assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence), [expected, "high", "high"]);
    assert.deepEqual(category(report, "unused-class").map((entry) => entry.confidence), [expected, "high"]);
    assert.match(category(report, "undefined-class")[0]?.reason ?? "", /Vérification nécessaire/);
  });
}

test("global coverage aggregates global styles, including explicit globals declared in a module", () => {
  const report = matchClasses(input({ definitions: [globalClass("shared", a), moduleClass("local", globalFile)],
    coverage: [
      { file: a, scope: "global", status: "complete" }, { file: a, scope: "module", status: "partial" },
      { file: globalFile, scope: "module", status: "complete" }, { file: globalFile, scope: "global", status: "complete" },
    ], usages: [staticUsage("shared", global), staticUsage("local", local(globalFile), 11), staticUsage("missing", global, 12)] }));
  assert.equal(category(report, "unused-class").length, 0);
  assert.equal(category(report, "undefined-class")[0]?.confidence, "high");
  assert.equal(report.completeness, "partial");
});

test("global definitions and resolved global imports with missing coverage prevent high confidence", () => {
  const absent = projectPath("src/unread.css");
  for (const options of [
    { definitions: [globalClass("unused", absent)] },
    { imports: [{ status: "resolved", scope: "global", target: absent, specifier: "./unread.css", location: sourceLocation(app, 1) } satisfies StyleImportReference] },
  ]) {
    const report = matchClasses(input({ ...options, usages: [staticUsage("missing", global), staticUsage("missing", local(b), 11)] }));
    assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence), ["low", "high"]);
    assert.equal(report.completeness, "partial");
  }
});

for (const [status, expected] of [["partial", "medium"], ["unreadable", "low"]] as const) {
  test(`${status} global coverage preserves independent module confidence`, () => {
    const report = matchClasses(input({ coverage: [{ file: globalFile, scope: "global", status }, { file: b, scope: "module", status: "complete" }],
      usages: [staticUsage("missing", global), staticUsage("missing", local(b), 11)] }));
    assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence), [expected, "high"]);
  });
}

test("an empty but fully analyzed module proves a static absence; missing coverage does not", () => {
  assert.equal(category(matchClasses(input({ usages: [staticUsage("missing")] })), "undefined-class")[0]?.confidence, "high");
  const report = matchClasses(input({ coverage: [], usages: [staticUsage("missing"), staticUsage("missing", global, 11)] }));
  assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence), ["low", "low"]);
  assert.equal(report.completeness, "partial");
});

test("warnings from every stage stay visible and respect their declared affected scopes", () => {
  const discovery = { ...warning([{ scope: "module", file: a }], "discovery"), code: "unreadable-source", location: sourceLocation(app, 1) };
  const styles = warning([{ scope: "module", file: a }]);
  const jsx = { ...warning([], "jsx"), code: "informational", location: sourceLocation(app, 3) };
  const report = matchClasses(input({ warnings: [discovery], styleWarnings: [styles], jsxWarnings: [jsx],
    definitions: [moduleClass("unused"), moduleClass("unused", b)],
    usages: [staticUsage("missing"), staticUsage("missing", local(b), 11), staticUsage("missing", global, 12)] }));
  assert.deepEqual(report.warnings, [styles, discovery, jsx]);
  assert.equal(category(report, "analysis-warning").length, 3);
  assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence), ["low", "high", "high"]);
  assert.deepEqual(category(report, "unused-class").map((entry) => entry.confidence), ["low", "high"]);
  assert.match(category(report, "undefined-class")[0]?.reason ?? "", /unreadable-source/);
  assert.match(category(report, "undefined-class")[0]?.reason ?? "", /undecidable-selector/);
  assert.equal(report.completeness, "partial");
});

for (const affectedScopes of [[{ scope: "global" }], [{ scope: "project" }]] as const) {
  test(`${affectedScopes[0].scope} warnings downgrade exactly their declared scope`, () => {
    const report = matchClasses(input({ styleWarnings: [warning(affectedScopes)],
      usages: [staticUsage("missing", global), staticUsage("missing", local(b), 11)] }));
    assert.deepEqual(category(report, "undefined-class").map((entry) => entry.confidence),
      affectedScopes[0].scope === "global" ? ["low", "high"] : ["low", "low"]);
  });
}

test("informational warnings alone leave the scan complete", () => {
  const report = matchClasses(input({ warnings: [warning([])] }));
  assert.equal(report.completeness, "complete");
  assert.equal(report.warnings.length, 1);
  assert.equal(report.diagnostics[0]?.category, "analysis-warning");
});

test("external global names and structured patterns allow only matching global usages", () => {
  const report = matchClasses(input({ externalGlobals: [
    { kind: "name", name: "sr-only" },
    { kind: "pattern", pattern: { parts: [{ kind: "literal", value: "icon-[" }, { kind: "unknown" }, { kind: "literal", value: "]" }] } },
  ], usages: [staticUsage("sr-only", global), staticUsage("icon-[add]", global, 11), staticUsage("icon-[]", global, 12),
    staticUsage("icon-add", global, 13), staticUsage("sr-only", local(), 14), dynamicUsage(free, global, 15)] }));
  assert.deepEqual(category(report, "undefined-class").map((entry) => entry.symbol?.name), ["icon-add", "sr-only"]);
  assert.ok(category(report, "undefined-class").every((entry) => entry.confidence === "high"));
  assert.deepEqual(category(report, "dynamic-usage")[0]?.candidates, []);
});

test("deduplication keeps distinct usage and declaration positions, including absent columns", () => {
  const definition = moduleClass("button--primary");
  const duplicate = { ...definition, selector: ".button--primary:hover" };
  const missing = staticUsage("missing");
  const noColumn = { ...missing, location: sourceLocation(app, 10) };
  const dynamic = dynamicUsage();
  const report = matchClasses(input({ definitions: [definition, definition, duplicate, moduleClass("button--primary", a, 4)],
    usages: [missing, missing, noColumn, staticUsage("missing", local(), 11), dynamic, { ...dynamic, candidates: ["button--primary"] },
      { ...dynamic, location: sourceLocation(app, 21, 8) }] }));
  assert.equal(category(report, "unused-class").length, 2);
  assert.equal(category(report, "undefined-class").length, 3);
  assert.deepEqual(category(report, "undefined-class").map((entry) => entry.location), [noColumn.location, missing.location, sourceLocation(app, 11, 4)]);
  assert.equal(category(report, "dynamic-usage").length, 2);
  for (const entry of category(report, "dynamic-usage")) {
    assert.deepEqual(entry.candidates.map((candidate) => candidate.location), [definition.location, sourceLocation(a, 4, 1)]);
  }
  assert.deepEqual([...report.diagnostics].sort(compareDiagnostics), report.diagnostics);
});

test("sorting and candidate merging are reproducible when independent inputs are reordered", () => {
  const unresolved = unknownImport([b, a]);
  const fixture = input({ definitions: [moduleClass("button--secondary", a, 12), moduleClass("button--primary", a, 2), moduleClass("title", b)],
    usages: [dynamicUsage(), staticUsage("missing", local(b), 10), dynamicUsage(free, { scope: "module", import: unresolved }, 3)],
    imports: [unresolved, moduleImport()], styleWarnings: [warning([{ scope: "module", file: a }]), warning([])],
    externalGlobals: [{ kind: "name", name: "foo" }, { kind: "name", name: "bar" }] });
  const reversed: AnalysisInput = { ...fixture, externalGlobals: [...fixture.externalGlobals].reverse(),
    styles: { ...fixture.styles, definitions: [...fixture.styles.definitions].reverse(), coverage: [...fixture.styles.coverage].reverse(), warnings: [...fixture.styles.warnings].reverse() },
    jsx: { ...fixture.jsx, imports: [...fixture.jsx.imports].reverse(), usages: [...fixture.jsx.usages].reverse() } };
  assert.equal(JSON.stringify(matchClasses(fixture)), JSON.stringify(matchClasses(reversed)));
});

test("contradictory coverage records keep the most cautious status regardless of order", () => {
  const coverage: StyleCoverage[] = [
    { file: a, scope: "module", status: "complete" }, { file: a, scope: "module", status: "partial" }, { file: a, scope: "module", status: "unreadable" },
  ];
  const fixture = input({ coverage, usages: [staticUsage("missing")] });
  const report = matchClasses(fixture);
  assert.equal(category(report, "undefined-class")[0]?.confidence, "low");
  assert.deepEqual(report, matchClasses(input({ coverage: [...coverage].reverse(), usages: fixture.jsx.usages })));
});

test("a global stylesheet import cannot prove the presence of local module exports", () => {
  const reference: UsageReference = { scope: "module", import: {
    status: "resolved", scope: "global", target: globalFile, specifier: "./global.css", binding: "styles", location: sourceLocation(app, 1),
  } };
  const report = matchClasses(input({ definitions: [globalClass("title")], usages: [staticUsage("title", reference)] }));
  assert.equal(category(report, "undefined-class")[0]?.confidence, "low");
  assert.match(category(report, "undefined-class")[0]?.reason ?? "", /exports locaux sont inconnus/);
  assert.equal(report.completeness, "partial");
});

test("matching accepts frozen in-memory inputs without mutation or disk access", () => {
  const fixture = input({ definitions: [moduleClass("button--primary")], usages: [dynamicUsage(), staticUsage("missing")] });
  const original = JSON.stringify(fixture);
  function freeze(value: unknown): void {
    if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  }
  freeze(fixture);
  assert.equal(matchClasses(fixture).completeness, "complete");
  assert.equal(JSON.stringify(fixture), original);
  assert.deepEqual(matchClasses(input({ coverage: [] })), { schemaVersion: 1, completeness: "complete", diagnostics: [], warnings: [] });
});

test("repeated warning diagnostics are deduplicated without removing original warnings", () => {
  const repeated = warning([{ scope: "module", file: a }]);
  const report = matchClasses(input({ styleWarnings: [repeated, repeated] }));
  assert.deepEqual(report.warnings, [repeated, repeated]);
  assert.equal(category(report, "analysis-warning").length, 1);
});

for (const syntax of ["css", "scss", "sass"]) {
  for (const scope of ["global", "module"] as const) {
    test(`${scope} ${syntax} definitions use the same identity and coverage rules`, () => {
      const file = projectPath(`src/styles${scope === "module" ? ".module" : ""}.${syntax}`);
      const definition = scope === "module" ? moduleClass("used", file) : globalClass("used", file);
      const reference = scope === "module" ? local(file) : global;
      const report = matchClasses(input({ definitions: [definition], coverage: [{ file, scope, status: "complete" }],
        usages: [staticUsage("used", reference), staticUsage("missing", reference, 11)] }));
      assert.equal(report.completeness, "complete");
      assert.equal(report.diagnostics.length, 1);
      assert.equal(report.diagnostics[0]?.category, "undefined-class");
      assert.equal(report.diagnostics[0]?.confidence, "high");
    });
  }
}
