import assert from "node:assert/strict";
import test from "node:test";
import type { ClassUsage, JsxAnalysis, ReactSource, ResolveStyleImport, StyleImportRequest } from "../src/contracts.js";
import { projectPath } from "../src/conventions.js";
import { analyzeJsx } from "../src/jsx/index.js";

const resolve: ResolveStyleImport = async (request) => ({
  ...request, status: "resolved", target: projectPath(`src/${request.specifier.replace(/^\.\//, "")}`),
  scope: request.binding ? "module" : "global",
});
const source = (content: string, syntax: ReactSource["syntax"] = "tsx", file = `src/App.${syntax}`): ReactSource => ({
  content, syntax, file: projectPath(file),
});
const analyze = (content: string, syntax: ReactSource["syntax"] = "tsx", resolver = resolve) =>
  analyzeJsx({ sources: [source(content, syntax)], resolveStyleImport: resolver });
const names = (result: JsxAnalysis) => result.usages.flatMap((usage) => usage.kind === "static" ? [usage.name] : []);
const dynamic = (result: JsxAnalysis) => result.usages.filter((usage) => usage.kind === "dynamic");
const owner = (usage: ClassUsage) => usage.reference.scope === "module" && usage.reference.import.status === "resolved"
  ? usage.reference.import.target : usage.reference.scope;

for (const syntax of ["js", "jsx", "ts", "tsx"] as const) {
  test(`${syntax}: only class contexts yield literal tokens, with original positions`, async () => {
    const result = await analyze([
      'const text = "not-a-class";',
      'const view = <><div className="card hero">ignored text</div>',
      '  <p title="also ignored" className={"message loud"} /></>;',
    ].join("\n"), syntax);
    assert.deepEqual(names(result), ["card", "hero", "message", "loud"]);
    assert.deepEqual(result.usages.map((usage) => usage.reference), Array(4).fill({ scope: "global" }));
    assert.deepEqual(result.usages.map((usage) => [usage.location.line, usage.location.column]), [[2, 32], [2, 37], [3, 39], [3, 47]]);
    assert.deepEqual(result.warnings, []);
  });
}

test("JSX supports clsx strings, nested arrays, object keys and && without collecting conditions", async () => {
  const result = await analyze([
    'import clsx from "clsx";',
    'const view = <div className={clsx("card", active && "card--active",',
    '  ["array", [ready ? "ready" : "waiting", null, false]],',
    '  { "object multiple": active, identifier: "not-a-class", [key]: active })} />;',
  ].join("\n"), "jsx");
  assert.deepEqual(names(result), ["card", "card--active", "array", "ready", "waiting", "object", "multiple", "identifier"]);
  assert.equal(dynamic(result).length, 1);
  assert.equal(dynamic(result)[0]?.expression, "key");
  assert.deepEqual(result.warnings, []);
});

test("TSX recognizes renamed default and named clsx/classnames imports, also outside JSX attributes", async () => {
  const result = await analyze([
    'import cx from "clsx";',
    'import { clsx as combine } from "clsx";',
    'import cn from "classnames";',
    'import { default as classes } from "classnames";',
    'const a = cx("card", active && "card--active");',
    'const b = cn({ "card--active": active });',
    'const view = <div className={combine("named", classes({ extra: ready }))} />;',
  ].join("\n"));
  assert.deepEqual(names(result), ["card", "card--active", "card--active", "named", "extra"]);
  assert.equal(result.usages.length, 5, "nested helper calls must not be emitted twice");
  assert.deepEqual(result.imports, []);
});

test("namespace helper imports are recognized through their supported exports", async () => {
  const result = await analyze([
    'import * as helpers from "clsx";',
    'import * as names from "classnames";',
    'const view = <div className={helpers.clsx("first", names.default("second"))} />;',
  ].join("\n"));
  assert.deepEqual(names(result), ["first", "second"]);
});

test("unimported helpers, unrelated imports and shadowed helper bindings do not confer class context", async () => {
  const result = await analyze([
    'import cx from "clsx";',
    'import classnames from "unrelated";',
    'function local(cx: (s: string) => string) { return cx("shadowed"); }',
    'classnames("unrelated-string"); clsx("unimported-string");',
    'const view = <div className={cx("actual")} />;',
  ].join("\n"));
  assert.deepEqual(names(result), ["actual"]);
});

test("ternaries keep both literal branches and logical conditions do not become classes", async () => {
  const result = await analyze([
    'const view = <><div className={flag === "ignored" ? "first" : "second"} />',
    '  <div className={active && "enabled"} />',
    '  <div className={unknown || "fallback"} />',
    '  <div className={other ?? "default"} /></>;',
  ].join("\n"));
  assert.deepEqual(names(result), ["first", "second", "enabled", "fallback", "default"]);
  assert.deepEqual(dynamic(result).map((usage) => usage.expression), ["unknown", "other"]);
});

test("template tokens separate fixed classes from structured dynamic patterns", async () => {
  const result = await analyze('const view = <button className={`button button--${variant} icon-${size}-dark end`} />;');
  assert.deepEqual(names(result), ["button", "end"]);
  const uncertain = dynamic(result);
  assert.deepEqual(uncertain.map((usage) => usage.pattern.parts), [
    [{ kind: "literal", value: "button--" }, { kind: "unknown" }],
    [{ kind: "literal", value: "icon-" }, { kind: "unknown" }, { kind: "literal", value: "-dark" }],
  ]);
  assert.ok(uncertain.every((usage) => usage.reference.scope === "global" && usage.candidates.length === 0 && usage.reason.length > 0));
  assert.ok(uncertain.every((usage) => usage.expression === '`button button--${variant} icon-${size}-dark end`'));
});

test("templates keep adjacent unknowns, suffixes and literal interpolations", async () => {
  const result = await analyze('const view = <div className={`${first}${second}-tail ${"fixed"} plain`} />;');
  assert.deepEqual(names(result), ["fixed", "plain"]);
  assert.deepEqual(dynamic(result).map((usage) => usage.pattern.parts), [
    [{ kind: "unknown" }, { kind: "literal", value: "-tail" }],
  ]);
});

test("literal escapes, multiline templates and UTF-16 columns map back to the original source", async () => {
  const content = [
    'const view = <div className={"\\u0063ard\\tsecond"} />;',
    'const more = <div title="😀" className={`first',
    '  second third`} />;',
  ].join("\r\n");
  const result = await analyze(content);
  assert.deepEqual(names(result), ["card", "second", "first", "second", "third"]);
  assert.deepEqual(result.usages.map((usage) => [usage.location.line, usage.location.column]), [
    [1, content.indexOf("\\u0063") + 1], [1, content.indexOf("second") + 1],
    [2, content.split("\r\n")[1]!.indexOf("first") + 1], [3, 3], [3, 10],
  ]);
});

test("two renamed CSS Module imports retain identity, use lines, and original resolver requests", async () => {
  const requests: StyleImportRequest[] = [];
  const result = await analyze([
    'import header from "./Header.module.scss";',
    'import footer from "./Footer.module.sass";',
    'const view = <>',
    '  <header className={header.title} />',
    '  <footer className={footer["card-title"]} />',
    '  <aside className={header["title"]} />',
    '</>;',
  ].join("\n"), "tsx", async (request) => { requests.push(request); return resolve(request); });
  assert.deepEqual(names(result), ["title", "card-title", "title"]);
  assert.deepEqual(result.usages.map(owner), ["src/Header.module.scss", "src/Footer.module.sass", "src/Header.module.scss"]);
  assert.deepEqual(result.usages.map((usage) => [usage.location.line, usage.location.column]), [[4, 22], [5, 22], [6, 21]]);
  assert.deepEqual(requests, [
    { specifier: "./Header.module.scss", binding: "header", location: { file: "src/App.tsx", line: 1, column: 1 } },
    { specifier: "./Footer.module.sass", binding: "footer", location: { file: "src/App.tsx", line: 2, column: 1 } },
  ]);
  assert.strictEqual(result.usages[0]?.reference.scope === "module" && result.usages[0].reference.import, result.imports[0]);
});

test("computed CSS Module keys stay dynamic and limited to their own module", async () => {
  const result = await analyze([
    'import styles from "./Card.module.css";',
    'const view = <div className={styles[key]} />;',
    'const other = <div className={styles[`card--${variant}`]} />;',
    'const known = <div className={styles[ready ? "yes" : "no"]} />;',
  ].join("\n"));
  assert.deepEqual(names(result), ["no", "yes"]);
  assert.deepEqual(dynamic(result).map((usage) => usage.expression), ["styles[key]", "styles[`card--${variant}`]"]);
  assert.deepEqual(dynamic(result).map((usage) => usage.pattern.parts), [
    [{ kind: "unknown" }],
    [{ kind: "literal", value: "card--" }, { kind: "unknown" }],
  ]);
  assert.ok(result.usages.every((usage) => owner(usage) === "src/Card.module.css"));
});

test("an unresolved import keeps its specifier, binding, reason and candidates on each usage", async () => {
  const result = await analyze([
    'import theme from "@/Missing.module.scss";',
    'const view = <><div className={theme.title} /><div className={theme[key]} /></>;',
  ].join("\n"), "tsx", async (request) => ({
    ...request, status: "unknown", reason: "Alias has no known target.", candidates: [projectPath("src/Missing.module.scss")],
  }));
  assert.equal(result.imports.length, 1);
  assert.deepEqual(result.imports[0], {
    specifier: "@/Missing.module.scss", binding: "theme", status: "unknown", reason: "Alias has no known target.",
    candidates: ["src/Missing.module.scss"], location: { file: "src/App.tsx", line: 1, column: 1 },
  });
  assert.ok(result.usages.every((usage) => usage.reference.scope === "module" && usage.reference.import === result.imports[0]));
});

test("module references compose with helpers, typed wrappers and isolated template interpolations", async () => {
  const result = await analyze([
    'import css from "./App.module.css";',
    'import cx from "clsx";',
    'const view = <div className={cx((css.title as string)!, { [css.active]: ready })} />;',
    'const more = <div className={`${css.title} static ${css[key]}`} />;',
  ].join("\n"));
  assert.deepEqual(names(result), ["title", "active", "title", "static"]);
  assert.equal(dynamic(result).length, 1);
  assert.equal(owner(dynamic(result)[0]!), "src/App.module.css");
  assert.ok(result.usages.filter((usage) => usage.kind === "static" && usage.name !== "static").every((usage) => owner(usage) === "src/App.module.css"));
});

test("a local parameter shadowing a module import never inherits its module identity", async () => {
  const result = await analyze([
    'import styles from "./App.module.css";',
    'function Card(styles: any) { return <div className={styles.title} />; }',
    'const view = <div className={styles.title} />;',
  ].join("\n"));
  assert.equal(result.usages.length, 2);
  assert.equal(result.usages[0]?.kind, "dynamic");
  assert.equal(result.usages[0]?.reference.scope, "global");
  assert.equal(result.usages[1]?.kind, "static");
  assert.equal(owner(result.usages[1]!), "src/App.module.css");
});

test("style imports cover all syntaxes, side effects, namespace and named bindings", async () => {
  const result = await analyze([
    'import "./global.css";',
    'import "./global.scss";',
    'import "./global.sass";',
    'import * as css from "./Card.module.css";',
    'import { title as heading } from "./Card.module.scss";',
    'import type Types from "./types.module.css";',
    'const view = <div className={heading ?? css.title} />;',
  ].join("\n"));
  assert.deepEqual(result.imports.map((entry) => [entry.specifier, entry.binding]), [
    ["./global.css", undefined], ["./global.scss", undefined], ["./global.sass", undefined],
    ["./Card.module.css", "css"], ["./Card.module.scss", "heading"],
  ]);
  assert.deepEqual(names(result), ["title", "title"]);
  assert.deepEqual(result.usages.map(owner), ["src/Card.module.scss", "src/Card.module.css"]);
});

test("resolver scope takes precedence over the spelling of a stylesheet import", async () => {
  const result = await analyze('import css from "./global.scss"; const view = <div className={css.title} />;', "tsx",
    async (request) => ({ ...request, status: "resolved", scope: "global", target: projectPath("src/global.scss") }));
  assert.deepEqual(names(result), ["title"]);
  assert.equal(result.usages[0]?.reference.scope, "global");
});

test("unsupported class expressions and spreads remain dynamic without mining arbitrary strings", async () => {
  const result = await analyze([
    'import cx from "clsx";',
    'const view = <><div className={makeClass("not-a-known-class")} />',
    '  <div className={cx(["known", ...external], { ...extra })} /></>;',
  ].join("\n"));
  assert.deepEqual(names(result), ["known"]);
  assert.deepEqual(dynamic(result).map((usage) => usage.expression), ['makeClass("not-a-known-class")', "external", "extra"]);
});

test("parse errors stay visible while recoverable usages and other sources survive", async () => {
  const result = await analyzeJsx({ sources: [
    source('const view = <div className="intact" />;', "jsx", "src/Z.jsx"),
    source('const view = <div className="kept" />;\nconst broken = <span className={;', "tsx", "src/A.tsx"),
  ], resolveStyleImport: resolve });
  assert.deepEqual(names(result), ["kept", "intact"]);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings.every((warning) => warning.stage === "jsx" && warning.code === "jsx-parse-error" &&
    warning.reason.length > 0 && warning.location.file === "src/A.tsx"));
  assert.deepEqual(result.warnings[0]?.affectedScopes, [{ scope: "project" }]);
});

test("results and resolver calls are deterministic and leave readonly inputs intact", async () => {
  const sources = Object.freeze([
    Object.freeze(source('import b from "./B.module.css"; const view = <div className={b.title} />;', "tsx", "src/Z.tsx")),
    Object.freeze(source('import a from "./A.module.css"; const view = <div className={a.title} />;', "tsx", "src/A.tsx")),
  ]);
  const calls: string[] = [];
  const resolver: ResolveStyleImport = async (request) => { calls.push(request.location.file); return resolve(request); };
  const result = await analyzeJsx({ sources, resolveStyleImport: resolver });
  assert.deepEqual(calls, ["src/A.tsx", "src/Z.tsx"]);
  assert.deepEqual(result.usages.map((usage) => usage.location.file), calls);
  assert.deepEqual(await analyzeJsx({ sources: [...sources].reverse(), resolveStyleImport: resolve }), result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(await analyzeJsx({ sources: [], resolveStyleImport: resolve }), { imports: [], usages: [], warnings: [] });
});
