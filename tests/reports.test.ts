import assert from "node:assert/strict";
import test from "node:test";
import { exampleReport } from "../examples/contract.js";
import type {
  AnalysisReport, AnalysisWarning, Confidence, Diagnostic, DiagnosticCategory,
  GetExitCode, RenderReport, ReportFormat, ScanOutcome,
} from "../src/index.js";
import { projectPath, sourceLocation } from "../src/conventions.js";
import { getExitCode, renderReport } from "../src/reports/index.js";

const formats: readonly ReportFormat[] = ["terminal", "json", "markdown"];
const emptyReport: AnalysisReport = { schemaVersion: 1, completeness: "complete", diagnostics: [], warnings: [] };

function diagnostic(category: DiagnosticCategory, confidence: Confidence = "high"): Diagnostic {
  return {
    category, confidence, reason: `${category} fixture`,
    location: sourceLocation(projectPath("src/App.tsx"), 12, 7), candidates: [],
  };
}

function successfulReport(diagnostics: readonly Diagnostic[], completeness: "complete" | "partial" = "complete"): ScanOutcome {
  return { status: "success", report: { ...emptyReport, completeness, diagnostics } };
}

function locationText(location: Diagnostic["location"]): string {
  return `${location.file}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
}

const labels: Readonly<Record<DiagnosticCategory, string>> = {
  "unused-class": "Classes probablement inutilisées",
  "undefined-class": "Classes manquantes",
  "dynamic-usage": "Usages dynamiques à vérifier",
  "unresolved-import": "Imports non résolus",
  "analysis-warning": "Diagnostics d’analyse",
};

test("implementations satisfy the shared entry-point signatures", () => {
  const render: RenderReport = renderReport;
  const exit: GetExitCode = getExitCode;
  assert.deepEqual(JSON.parse(render(emptyReport, "json")), emptyReport);
  assert.equal(exit({ status: "success", report: emptyReport }, { failOnMissing: true }), 0);
});

test("one reference report retains matching counts and locations in all three formats", () => {
  const json = JSON.parse(renderReport(exampleReport, "json")) as AnalysisReport;
  assert.deepEqual(json, exampleReport);
  assert.equal(json.completeness, "partial");
  assert.equal(json.warnings.length, 1);
  assert.equal(json.diagnostics.length, 4);
  for (const format of ["terminal", "markdown"] as const) {
    const text = renderReport(exampleReport, format);
    assert.ok(text.includes("Scan incomplet (partial)."));
    assert.ok(text.includes(`Diagnostics : ${json.diagnostics.length}`));
    assert.ok(text.includes(`Avertissements : ${json.warnings.length}`));
    for (const [category, label] of Object.entries(labels)) {
      const count = json.diagnostics.filter((entry) => entry.category === category).length;
      assert.ok(text.includes(`${label} : ${count}`), `${format}: count of ${category}`);
    }
    for (const entry of json.diagnostics) {
      assert.ok(text.includes(locationText(entry.location)), `${format}: diagnostic location`);
      assert.ok(text.includes(`[${entry.category}]`));
      assert.ok(text.includes(entry.confidence));
      // Markdown escapes prose punctuation without changing the underlying reason.
      assert.ok(text.replace(/\\([\\`*_\[\]{}()#+.!|~\-])/g, "$1").includes(entry.reason));
      for (const candidate of entry.candidates) {
        assert.ok(text.includes("Candidats compatibles :"));
        assert.ok(text.includes(locationText(candidate.location)));
        assert.ok(text.includes(candidate.symbol.name));
        assert.ok(text.includes(candidate.confidence));
        assert.ok(text.replace(/\\([\\`*_\[\]{}()#+.!|~\-])/g, "$1").includes(candidate.reason));
        if (candidate.symbol.scope === "module") assert.ok(text.includes(candidate.symbol.file));
      }
    }
    for (const warning of json.warnings) {
      assert.ok(text.includes(locationText(warning.location)));
      assert.ok(text.includes(warning.stage));
      assert.ok(text.includes(warning.code));
      assert.ok(text.replace(/\\([\\`*_\[\]{}()#+.!|~\-])/g, "$1").includes(warning.reason));
    }
    assert.ok(text.indexOf("Diagnostics :") < text.indexOf("Classes probablement inutilisées (1)"));
    assert.ok(text.indexOf("Classes probablement inutilisées (1)") < text.indexOf("Classes manquantes (1)"));
    assert.ok(text.indexOf("Classes manquantes (1)") < text.indexOf("Usages dynamiques à vérifier (1)"));
  }
});

test("an empty report has readable primary sections and valid JSON", () => {
  assert.equal(renderReport(emptyReport, "terminal"), [
    "CSS Cleaner", "", "Scan complet (complete).", "", "Diagnostics : 0",
    "- Classes probablement inutilisées : 0", "- Classes manquantes : 0",
    "- Usages dynamiques à vérifier : 0", "- Imports non résolus : 0",
    "- Diagnostics d’analyse : 0", "- Avertissements : 0", "",
    "Classes probablement inutilisées (0)", "", "Aucun résultat.", "",
    "Classes manquantes (0)", "", "Aucun résultat.", "",
    "Usages dynamiques à vérifier (0)", "", "Aucun résultat.", "",
    "Avertissements (0)", "", "Aucun avertissement.", "",
  ].join("\n"));
  const markdown = renderReport(emptyReport, "markdown");
  assert.ok(markdown.startsWith("# CSS Cleaner\n"));
  assert.ok(markdown.includes("## Classes manquantes (0)\n\nAucun résultat."));
  assert.ok(markdown.includes("## Avertissements (0)\n\nAucun avertissement."));
  assert.deepEqual(JSON.parse(renderReport(emptyReport, "json")), emptyReport);
});

test("all renderings are repeatable and leave deeply frozen input untouched", () => {
  function freeze(value: unknown): void {
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) freeze(entry);
      Object.freeze(value);
    }
  }
  const report: AnalysisReport = structuredClone(exampleReport);
  const before = structuredClone(report);
  freeze(report);
  for (const format of formats) {
    assert.equal(renderReport(report, format), renderReport(report, format));
    assert.equal(renderReport(emptyReport, format), renderReport(emptyReport, format));
    assert.ok(renderReport(report, format).endsWith("\n"));
    assert.ok(!renderReport(report, format).includes("\r"));
  }
  assert.deepEqual(report, before);
});

test("JSON canonicalizes object keys while preserving every contract field", () => {
  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
  }
  const reordered = reverseKeys(exampleReport) as AnalysisReport;
  assert.equal(renderReport(reordered, "json"), renderReport(exampleReport, "json"));
  assert.deepEqual(JSON.parse(renderReport(reordered, "json")), exampleReport);
});

test("diagnostics, candidates, warnings and scopes retain producer order", () => {
  const entry = diagnostic("dynamic-usage", "low");
  const candidates = ["Z", "A"].map((name) => ({
    symbol: { scope: "module", file: projectPath(`src/${name}.module.sass`), name } as const,
    location: sourceLocation(projectPath(`src/${name}.module.sass`), 10),
    confidence: "low" as const, reason: `candidate ${name}`,
  }));
  const warnings: AnalysisWarning[] = ["Z", "A"].map((name) => ({
    stage: "styles", code: `warning-${name}`, reason: name,
    location: sourceLocation(projectPath(`src/${name}.scss`), 10),
    affectedScopes: [{ scope: "module", file: projectPath("src/Z.module.sass") }, { scope: "global" }],
  }));
  const report: AnalysisReport = {
    ...emptyReport,
    diagnostics: [
      { ...entry, reason: "emitted first", candidates, location: sourceLocation(projectPath("src/Z.tsx"), 10) },
      { ...entry, reason: "emitted second", location: sourceLocation(projectPath("src/A.tsx"), 2) },
    ],
    warnings,
  };
  assert.deepEqual(JSON.parse(renderReport(report, "json")), report);
  for (const format of ["terminal", "markdown"] as const) {
    const text = renderReport(report, format);
    assert.ok(text.indexOf("emitted first") < text.indexOf("emitted second"));
    assert.ok(text.indexOf("candidate Z") < text.indexOf("candidate A"));
    assert.ok(text.indexOf("warning-Z") < text.indexOf("warning-A"));
    assert.ok(text.includes("src/Z.tsx:10"));
    assert.ok(!text.includes("src/Z.tsx:10:undefined"));
    assert.ok(!text.includes("src/Z.tsx:10:0"));
  }
});

test("supplementary diagnostics and every warning stage remain visible", () => {
  const report: AnalysisReport = {
    ...emptyReport, completeness: "partial",
    diagnostics: [diagnostic("unresolved-import", "low"), diagnostic("analysis-warning", "medium")],
    warnings: ["discovery", "styles", "jsx"].map((stage) => ({
      stage: stage as AnalysisWarning["stage"], code: `${stage}-limit`, reason: `${stage} limitation`,
      location: sourceLocation(projectPath("src/App.tsx"), 4),
      affectedScopes: stage === "discovery" ? [{ scope: "project" }] : [],
    })),
  };
  assert.deepEqual(JSON.parse(renderReport(report, "json")), report);
  for (const format of ["terminal", "markdown"] as const) {
    const text = renderReport(report, format);
    assert.ok(text.includes("Imports non résolus (1)"));
    assert.ok(text.includes("Diagnostics d’analyse (1)"));
    assert.ok(text.includes("Avertissements (3)"));
    assert.ok(text.includes("project"));
    assert.ok(text.includes("aucune (informatif)"));
    for (const warning of report.warnings) assert.ok(text.includes(`${warning.stage} limitation`));
  }
  assert.equal(getExitCode({ status: "success", report }, { failOnMissing: true }), 0);
});

test("an incomplete report is explicit even without warnings or diagnostics", () => {
  const report: AnalysisReport = { ...emptyReport, completeness: "partial" };
  for (const format of ["terminal", "markdown"] as const) {
    assert.ok(renderReport(report, format).includes("Scan incomplet (partial)."));
  }
  assert.equal(JSON.parse(renderReport(report, "json")).completeness, "partial");
  assert.equal(getExitCode({ status: "success", report }, { failOnMissing: true }), 0);
});

test("homonymous module candidates retain both owner files and declaration locations", () => {
  const report: AnalysisReport = {
    ...emptyReport,
    diagnostics: [{
      ...diagnostic("dynamic-usage", "low"),
      candidates: ["Header.module.scss", "Footer.module.sass"].map((file) => ({
        symbol: { scope: "module", file: projectPath(`src/${file}`), name: "button" },
        location: sourceLocation(projectPath("src/shared.scss"), 20, 4),
        confidence: "medium", reason: "compatible module class",
      })),
    }],
  };
  assert.deepEqual(JSON.parse(renderReport(report, "json")), report);
  for (const format of ["terminal", "markdown"] as const) {
    const text = renderReport(report, format);
    assert.ok(text.includes("src/Header.module.scss"));
    assert.ok(text.includes("src/Footer.module.sass"));
    assert.equal(text.split("src/shared.scss:20:4").length - 1, 2);
  }
});

test("source punctuation and control characters remain data in Markdown, terminal and JSON", () => {
  const report: AnalysisReport = {
    ...emptyReport,
    diagnostics: [{
      ...diagnostic("undefined-class"),
      reason: "<script>alert(1)</script> & [link](url)\n# heading\u001b[31m",
      location: sourceLocation(projectPath("src/a`b.tsx"), 3),
      symbol: { scope: "global", name: "a``b" },
    }],
  };
  const markdown = renderReport(report, "markdown");
  assert.ok(markdown.includes("&lt;script&gt;"));
  assert.ok(markdown.includes("&amp;"));
  assert.ok(markdown.includes("\\[link\\]\\(url\\)"));
  assert.ok(markdown.includes("`` src/a`b.tsx:3 ``"));
  assert.ok(markdown.includes('``` global "a``b" ```'));
  assert.ok(!markdown.includes("\n# heading"));
  const terminal = renderReport(report, "terminal");
  assert.ok(!terminal.includes("\u001b"));
  assert.ok(terminal.includes("\\u001b[31m"));
  assert.ok(terminal.includes("\\n# heading"));
  assert.deepEqual(JSON.parse(renderReport(report, "json")), report);
});

test("a successful scan returns 0 unless failOnMissing is enabled", () => {
  assert.equal(getExitCode(successfulReport([]), { failOnMissing: false }), 0);
  assert.equal(getExitCode(successfulReport([]), { failOnMissing: true }), 0);
  assert.equal(getExitCode(successfulReport([diagnostic("undefined-class")]), { failOnMissing: false }), 0);
});

test("only a high-confidence missing class triggers code 1", () => {
  for (const completeness of ["complete", "partial"] as const) {
    assert.equal(getExitCode(successfulReport([diagnostic("undefined-class")], completeness), { failOnMissing: true }), 1);
    for (const confidence of ["medium", "low"] as const) {
      assert.equal(getExitCode(successfulReport([diagnostic("undefined-class", confidence)], completeness), { failOnMissing: true }), 0);
    }
  }
  assert.equal(getExitCode(successfulReport([
    diagnostic("undefined-class", "low"), diagnostic("dynamic-usage"), diagnostic("undefined-class"),
  ]), { failOnMissing: true }), 1);
});

test("unused classes, dynamic usages, unresolved imports and analysis warnings never trigger code 1", () => {
  const diagnostics = (["unused-class", "dynamic-usage", "unresolved-import", "analysis-warning"] as const)
    .map((category) => diagnostic(category));
  for (const entry of diagnostics) {
    assert.equal(getExitCode(successfulReport([entry]), { failOnMissing: true }), 0);
  }
  assert.equal(getExitCode(successfulReport(diagnostics), { failOnMissing: true }), 0);
  assert.equal(getExitCode({ status: "success", report: exampleReport }, { failOnMissing: true }), 0);
});

test("candidate confidence does not turn a missing or dynamic diagnostic into a certain missing class", () => {
  for (const category of ["undefined-class", "dynamic-usage"] as const) {
    const entry: Diagnostic = {
      ...diagnostic(category, "low"), candidates: [{
        symbol: { scope: "global", name: "known" },
        location: sourceLocation(projectPath("src/global.css"), 2),
        reason: "known candidate", confidence: "high",
      }],
    };
    assert.equal(getExitCode(successfulReport([entry]), { failOnMissing: true }), 0);
  }
});

test("fatal execution errors return 2 with and without a location, regardless of policy", () => {
  for (const failOnMissing of [false, true]) {
    assert.equal(getExitCode({ status: "error", reason: "Cannot discover project" }, { failOnMissing }), 2);
    assert.equal(getExitCode({
      status: "error", reason: "Cannot read configuration",
      location: sourceLocation(projectPath("css-cleaner.config.json"), 1),
    }, { failOnMissing }), 2);
  }
});
