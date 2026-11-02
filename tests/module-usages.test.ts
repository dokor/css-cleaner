import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveredProject, StyleSource, StyleSyntax } from "../src/contracts.js";
import { projectPath } from "../src/conventions.js";
import { createStyleImportResolver } from "../src/discovery/index.js";
import { analyzeJsx } from "../src/jsx/index.js";
import { matchClasses } from "../src/matching/index.js";
import { analyzeStyles } from "../src/styles/index.js";

function style(file: string, content: string): StyleSource {
  return {
    file: projectPath(file), content,
    syntax: file.split(".").at(-1) as StyleSyntax,
    scope: file.includes(".module.") ? "module" : "global",
  };
}

async function audit(styles: readonly StyleSource[], content: string) {
  const project: DiscoveredProject = {
    config: { rootDir: "/example", include: [], exclude: [], aliases: {}, externalGlobals: [] },
    styles,
    react: [{ file: projectPath("src/App.tsx"), syntax: "tsx", content }],
    warnings: [],
  };
  const jsx = await analyzeJsx({ sources: project.react, resolveStyleImport: createStyleImportResolver(project) });
  const definitions = await analyzeStyles(styles);
  const report = matchClasses({ styles: definitions, jsx, externalGlobals: [], warnings: [] });
  return { jsx, definitions, report };
}

for (const syntax of ["css", "scss", "sass"] as const) {
  test(`indirect .module.${syntax} reads retain their owner and source position`, async () => {
    const file = `src/Card.module.${syntax}`;
    const { jsx, report } = await audit([
      style(file, syntax === "sass" ? ".title\n  color: red\n.dead\n  color: blue" : ".title {}\n.dead {}"),
      style("src/Other.module.css", ".title {}"),
    ], [
      `import s from './Card.module.${syntax}';`,
      "const name = s.title;",
      "export default () => <div className={name} />;",
    ].join("\n"));
    const read = jsx.usages.find(usage => usage.kind === "static" && usage.name === "title");
    assert.ok(read);
    assert.deepEqual(read.location, { file: "src/App.tsx", line: 2, column: 14 });
    assert.equal(read.reference.scope, "module");
    if (read.reference.scope !== "module") assert.fail("Expected module identity");
    assert.equal(read.reference.import.status, "resolved");
    if (read.reference.import.status !== "resolved") assert.fail("Expected a resolved module");
    assert.equal(read.reference.import.target, file);
    assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === file && d.symbol.name === "title"));
    assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.name === "dead" && d.confidence === "high"));
    assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === "src/Other.module.css" && d.confidence === "high"));
  });

  test(`local compositions in .module.${syntax} lower confidence in the owning module`, async () => {
    const { definitions, report } = await audit([
      style(`src/Card.module.${syntax}`, syntax === "sass"
        ? ".base\n  color: red\n.card\n  composes: base"
        : ".base {}\n.card { composes: base; }"),
      style("src/Other.module.css", ".base {}"),
    ], `import s from './Card.module.${syntax}'; export default () => <div className={s.card} />;`);
    const warning = definitions.warnings.find(w => w.code === "unresolved-css-composition");
    assert.ok(warning);
    assert.deepEqual(warning.affectedScopes, [{ scope: "module", file: `src/Card.module.${syntax}` }]);
    assert.equal(warning.location.line, syntax === "sass" ? 4 : 2);
    assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === `src/Card.module.${syntax}` && d.symbol.name === "base" && d.confidence === "low"));
    assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === "src/Other.module.css" && d.confidence === "high"));
    assert.equal(report.completeness, "partial");
  });
}

test("indirect computed module reads keep their dynamic pattern in the correct scope", async () => {
  const { jsx, report } = await audit([
    style("src/Card.module.css", ".title {} .other {}"),
    style("src/Other.module.css", ".title {}"),
  ], "import s from './Card.module.css'; const name = s[key]; export default () => <div className={name}/>;");
  assert.ok(jsx.usages.some(u => u.kind === "dynamic" && u.reference.scope === "module"));
  assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === "src/Card.module.css" && d.confidence === "high"));
  assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === "src/Other.module.css" && d.confidence === "high"));
});

test("module-object aliases make the exports of their source module uncertain", async () => {
  const { report } = await audit([
    style("src/Card.module.css", ".title {}"),
    style("src/Other.module.css", ".title {}"),
  ], "import s from './Card.module.css'; const alias = s; export default () => <div className={alias.title}/>;");
  assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === "src/Card.module.css" && d.confidence === "high"));
  assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.scope === "module" && d.symbol.file === "src/Other.module.css" && d.confidence === "high"));
});

for (const [name, composition, targetFile] of [
  ["relative module", 'base from "./Base.module.css"', "src/Base.module.css"],
  ["relative global file", "base from './base.css'", "src/base.css"],
  ["parent module", 'base from "../Base.module.css"', "Base.module.css"],
  ["comments", 'base /* from an import */ from /* comment */ "./Base.module.css"', "src/Base.module.css"],
] as const) {
  test(`composition from a ${name} limits uncertainty to the source and target scopes`, async () => {
    const { definitions, report } = await audit([
      style("src/Card.module.css", `.card { composes: ${composition}; }`),
      style(targetFile, ".base {}"),
      style("src/Other.module.css", ".base {}"),
    ], "import s from './Card.module.css'; export default () => <div className={s.card}/>;");
    const warning = definitions.warnings.find(w => w.code === "unresolved-css-composition");
    assert.ok(warning);
    assert.ok(warning.affectedScopes.some(s => s.scope === "module" && s.file === "src/Card.module.css"));
    assert.ok(!warning.affectedScopes.some(s => s.scope === "project"));
    assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.location.file === targetFile && d.confidence === "high"));
    assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.location.file === "src/Other.module.css" && d.confidence === "high"));
  });
}

test("composition from global lowers global confidence while preserving independent modules", async () => {
  const { definitions, report } = await audit([
    style("src/Card.module.css", ".card { composes: base from global; }"),
    style("src/base.css", ".base {}"),
    style("src/Other.module.css", ".base {}"),
  ], "import s from './Card.module.css'; export default () => <div className={s.card}/>;");
  assert.deepEqual(definitions.warnings[0]?.affectedScopes, [{ scope: "module", file: "src/Card.module.css" }, { scope: "global" }]);
  assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.location.file === "src/base.css" && d.confidence === "low"));
  assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.location.file === "src/Other.module.css" && d.confidence === "high"));
});

test("composition targets include explicit local classes in a global stylesheet", async () => {
  const { report } = await audit([
    style("src/Card.module.css", '.card { composes: base from "./base.css"; }'),
    style("src/base.css", ":local(.base) {}"),
    style("src/Other.module.css", ".base {}"),
  ], "import s from './Card.module.css'; export default () => <div className={s.card}/>;");
  assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.location.file === "src/base.css" && d.confidence === "high"));
  assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.location.file === "src/Other.module.css" && d.confidence === "high"));
});

test("interpolated composition paths cannot be mistaken for known module identities", async () => {
  const { definitions, report } = await audit([
    style("src/Card.module.scss", '.card { composes: base from "./#{theme}.module.css"; }'),
    style("src/Base.module.css", ".base {}"),
  ], "import s from './Card.module.scss'; export default () => <div className={s.card}/>;");
  assert.ok(definitions.warnings.some(w => w.affectedScopes.some(s => s.scope === "project")));
  assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.confidence === "high"));
});

test("module imports alone and shadowed intermediate reads do not mark their exports used", async () => {
  const { jsx, report } = await audit([
    style("src/Card.module.css", ".title {}"),
  ], [
    "import s from './Card.module.css';",
    "function local(s: any) { const name = s.title; return <div className={name}/>; }",
  ].join("\n"));
  assert.ok(!jsx.usages.some(u => u.reference.scope === "module"));
  assert.ok(report.diagnostics.some(d => d.category === "unused-class" && d.symbol?.name === "title" && d.confidence === "high"));
});

test("a composition with an unknown import origin explicitly makes the scan uncertain", async () => {
  const { definitions, report } = await audit([
    style("src/Card.module.scss", '.card { composes: base from "@/Base.module.css"; }'),
    style("src/Other.module.css", ".base {}"),
  ], "import s from './Card.module.scss'; export default () => <div className={s.card}/>;");
  assert.ok(definitions.warnings.some(w => w.code === "unresolved-css-composition" && w.affectedScopes.some(s => s.scope === "project")));
  assert.ok(!report.diagnostics.some(d => d.category === "unused-class" && d.confidence === "high"));
  assert.equal(report.completeness, "partial");
});
