import assert from "node:assert/strict";
import test from "node:test";
import type { ClassDefinition, StyleSource, StyleSyntax } from "../src/contracts.js";
import { classSymbolKey, projectPath } from "../src/conventions.js";
import { analyzeStyles } from "../src/styles/index.js";

function source(file: string, content: string): StyleSource {
  return {
    file: projectPath(file), content,
    syntax: file.split(".").at(-1) as StyleSyntax,
    scope: file.includes(".module.") ? "module" : "global",
  };
}

function names(definitions: readonly ClassDefinition[]): string[] {
  return definitions.map((entry) => entry.symbol.name);
}

for (const extension of ["css", "scss", "sass", "module.css", "module.scss", "module.sass"]) {
  test(`analyzes .${extension} in memory, preserving source lines and ownership`, async () => {
    const input = source(`src/Card.${extension}`, extension.endsWith("sass")
      ? "// .ignored\n.card\n  &__title\n    color: red\n  &--active\n    color: blue\n"
      : "/* .ignored */\n.card { color: red; }\n.card:hover .title { content: '.not-a-class'; }\n");
    const result = await analyzeStyles([input]);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(names(result.definitions), extension.endsWith("sass")
      ? ["card", "card__title", "card--active"] : ["card", "card", "title"]);
    for (const { symbol, location } of result.definitions) {
      assert.equal(symbol.scope, input.scope);
      if (symbol.scope === "module") assert.equal(symbol.file, input.file);
      assert.equal(location.file, input.file);
      assert.ok(location.column && location.column >= 1);
    }
    assert.deepEqual(result.coverage, [{ file: input.file, scope: input.scope, status: "complete" }]);
    if (extension.endsWith("sass")) {
      assert.deepEqual(result.definitions.map(({ location }) => [location.line, location.column]), [[2, 1], [3, 3], [5, 3]]);
    }
  });
}

test("compound selectors, pseudo-classes and lists yield individual class tokens", async () => {
  const result = await analyzeStyles([source("styles.css", ".button.primary,\n.card:hover .title,\n:is(.wide, .narrow) > .content { color: red; }")]);
  assert.deepEqual(names(result.definitions), ["button", "primary", "card", "title", "wide", "narrow", "content"]);
  assert.deepEqual(result.definitions.map(({ location }) => [location.line, location.column]), [
    [1, 1], [1, 8], [2, 1], [2, 13], [3, 5], [3, 12], [3, 23],
  ]);
});

test("comments, declarations, strings, attribute values and at-rule parameters do not define classes", async () => {
  const result = await analyzeStyles([source("styles.scss", `
// .comment
/* .block-comment */
$example: '.variable';
@supports selector(.parameter) {
  .real[data-label=".attribute"] {
    content: '.example';
    background: url('.image.png');
    --json: '{"class": ".string"}';
  }
}
`)]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(names(result.definitions), ["real"]);
});

test("SCSS expands BEM, multiple parents, compounds and nested descendants", async () => {
  const result = await analyzeStyles([source("styles.scss", `.card, .panel {
  &__title, &--active {
    &--large {}
    .icon {}
  }
}
.button.primary { &--active {} }
`)]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(names(result.definitions), [
    "card", "panel", "card__title", "panel__title", "card--active", "panel--active",
    "card--active--large", "card__title--large", "panel--active--large", "panel__title--large",
    "icon", "button", "primary", "primary--active",
  ]);
  assert.equal(result.definitions.find((entry) => entry.symbol.name === "card__title")?.selector, ".card__title");
  assert.equal(result.definitions.find((entry) => entry.symbol.name === "primary--active")?.selector, ".button.primary--active");
  assert.deepEqual(result.definitions.find((entry) => entry.symbol.name === "icon")?.location, { file: "styles.scss", line: 4, column: 5 });
});

test("CSS nesting resolves parent references and preserves descendant token positions", async () => {
  const result = await analyzeStyles([source("styles.css", ".card { &:hover .title {} .icon {} }")]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(names(result.definitions), ["card", "title", "icon"]);
  assert.equal(result.definitions[1]?.selector, ".card:hover .title");
  assert.equal(result.definitions[1]?.location.column, 17);
});

test("CSS Modules keep homonyms distinct and explicit global classes share one identity", async () => {
  const result = await analyzeStyles([
    source("B.module.scss", ".title {} :global(.shared) .local {}"),
    source("A.module.css", ".title {} :global(.shared) .local {}"),
    source("global.css", ".shared {}"),
  ]);
  assert.deepEqual(result.warnings, []);
  const titles = result.definitions.filter((entry) => entry.symbol.name === "title");
  assert.equal(new Set(titles.map((entry) => classSymbolKey(entry.symbol))).size, 2);
  const globals = result.definitions.filter((entry) => entry.symbol.name === "shared");
  assert.equal(globals.length, 3);
  assert.equal(new Set(globals.map((entry) => classSymbolKey(entry.symbol))).size, 1);
  assert.ok(globals.every((entry) => entry.symbol.scope === "global"));
  assert.deepEqual(result.coverage, [
    { file: "A.module.css", scope: "global", status: "complete" },
    { file: "A.module.css", scope: "module", status: "complete" },
    { file: "B.module.scss", scope: "global", status: "complete" },
    { file: "B.module.scss", scope: "module", status: "complete" },
    { file: "global.css", scope: "global", status: "complete" },
  ]);
});

test("functional and bare scope switches, nested overrides and scope blocks stay local to their context", async () => {
  const result = await analyzeStyles([source("styles.module.scss", `
:global(.outer :local(.inner)) .normal {}
:global .g :local .l {}
:global { .block {} }
.card { :global { .child {} } }
:global(.base) { &.extra {} }
`)]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.definitions.map(({ symbol }) => [symbol.name, symbol.scope]), [
    ["outer", "global"], ["inner", "module"], ["normal", "module"],
    ["g", "global"], ["l", "module"], ["block", "global"], ["card", "module"],
    ["child", "global"], ["base", "global"], ["extra", "module"],
  ]);
});

test("bare global scope continues into nested selectors while explicit local scope wins", async () => {
  const result = await analyzeStyles([source("A.module.scss", ":global .base { .child {} :local(.local) {} :local { .block {} } }")]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.definitions.map(({ symbol }) => [symbol.name, symbol.scope]), [
    ["base", "global"], ["child", "global"], ["local", "module"], ["block", "module"],
  ]);
});

test("indented Sass modules support functional global escapes alongside nested BEM classes", async () => {
  const result = await analyzeStyles([source("A.module.sass", ".card\n  &__title\n    color: red\n  :global(.external) .local\n    color: blue\n")]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.definitions.map(({ symbol, location }) => [symbol.name, symbol.scope, location.line, location.column]), [
    ["card", "module", 1, 1], ["card__title", "module", 2, 3],
    ["external", "global", 4, 11], ["local", "module", 4, 22],
  ]);
});

for (const extension of ["scss", "sass"]) {
  test(`${extension} interpolation is uncertain; independent rules and files continue`, async () => {
    const bad = source(`B.module.${extension}`, extension === "sass"
      ? ".button-#{$variant}\n  &__icon\n    color: red\n.safe\n  color: blue\n"
      : ".button-#{$variant} { &__icon {} .unproven {} }\n.safe {}\n");
    const result = await analyzeStyles([bad, source("A.module.css", ".title {}")]);
    assert.deepEqual(names(result.definitions), ["title", "safe"]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "dynamic-style-selector");
    assert.deepEqual(result.warnings[0]?.location, { file: bad.file, line: 1, column: 9 });
    assert.deepEqual(result.warnings[0]?.affectedScopes, [{ scope: "module", file: bad.file }]);
    assert.deepEqual(result.coverage, [
      { file: "A.module.css", scope: "module", status: "complete" },
      { file: bad.file, scope: "module", status: "partial" },
    ]);
  });
}

test("uncertain global escape in a module degrades both affected scopes", async () => {
  const result = await analyzeStyles([source("A.module.scss", ":global(.dynamic-#{$x}) {} .certain {}")]);
  assert.deepEqual(names(result.definitions), ["certain"]);
  assert.deepEqual(result.warnings[0]?.affectedScopes, [{ scope: "global" }, { scope: "module", file: "A.module.scss" }]);
  assert.ok(result.coverage.every((entry) => entry.status === "partial"));
});

test("uncertainty includes global parents and scope escapes in discarded descendants", async () => {
  for (const content of [
    ".a { :global(.g) { &-#{$variant} {} } }",
    ".a-#{$variant} { :global(.external) {} }",
  ]) {
    const result = await analyzeStyles([source("A.module.scss", content)]);
    assert.deepEqual(result.warnings[0]?.affectedScopes, [{ scope: "global" }, { scope: "module", file: "A.module.scss" }]);
    assert.ok(result.coverage.every((entry) => entry.status === "partial"));
    assert.ok(!names(result.definitions).includes("external"));
  }
});

for (const [extension, content] of [
  ["css", ".phantom { color: red;"],
  ["scss", ".phantom { color: red;"],
  ["sass", ".phantom\n  color: red\n invalid\n"],
] as const) {
  test(`malformed ${extension} emits a localized warning and never leaks certain definitions`, async () => {
    const input = source(`B.module.${extension}`, content);
    const result = await analyzeStyles([input, source("A.css", ".valid {}")]);
    assert.deepEqual(names(result.definitions), ["valid"]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "style-syntax-error");
    assert.equal(result.warnings[0]?.location.file, input.file);
    assert.ok(result.warnings[0]?.location.line);
    assert.deepEqual(result.coverage.filter((entry) => entry.file === input.file), [
      { file: input.file, scope: "global", status: "unreadable" },
      { file: input.file, scope: "module", status: "unreadable" },
    ]);
  });
}

test("Sass computations are reported rather than treated as certain declarations", async () => {
  const result = await analyzeStyles([source("styles.scss", `
@use 'never-read-from-disk';
@mixin styles { .mixin-class {} }
@include styles;
@if false { .conditional {} }
@each $x in red, blue { .loop-#{$x} {} }
%placeholder { .placeholder-child {} }
.safe { @extend %placeholder; }
`)]);
  assert.deepEqual(names(result.definitions), ["safe"]);
  assert.equal(result.warnings.length, 7);
  assert.ok(result.warnings.every((warning) => warning.code === "unsupported-sass-construction"));
  assert.ok(result.coverage.every((entry) => entry.status === "partial"));
});

test("source positions use original multiline selectors, CRLF and UTF-16 columns", async () => {
  for (const extension of ["css", "scss", "sass"]) {
    const input = source(`styles.${extension}`, extension === "sass"
      ? ".a,\r\n  .b:hover\r\n  content: '😀'\r\n.😀.last\r\n  color: red\r\n"
      : ".a,\r\n  .b:hover { content: '😀'; }\r\n.😀.last {}\r\n");
    const result = await analyzeStyles([input]);
    assert.deepEqual(result.warnings, [], extension);
    const lastLine = extension === "sass" ? 4 : 3;
    assert.deepEqual(result.definitions.map(({ location }) => [location.line, location.column]), [[1, 1], [2, 3], [lastLine, 1], [lastLine, 4]], extension);
  }
});

test("CSS escapes are decoded while token positions stay at the original dot", async () => {
  const result = await analyzeStyles([source("styles.scss", String.raw`.caf\e9, .hover\:active, .\31 23 { color: red; }`)]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(names(result.definitions), ["café", "hover:active", "123"]);
  assert.deepEqual(result.definitions.map(({ location }) => location.column), [1, 10, 26]);
});

test("comments within selectors preserve class positions and static BEM expansion", async () => {
  const result = await analyzeStyles([source("styles.scss", ".card/* .ignored */.primary { &/* ignored */__title {} }")]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(names(result.definitions), ["card", "primary", "primary__title"]);
  assert.deepEqual(result.definitions.map(({ location }) => location.column), [1, 20, 31]);
});

test("invalid selector lists are uncertain without discarding independent valid rules", async () => {
  const result = await analyzeStyles([source("styles.css", ".invalid, { color: red; } .valid {}")]);
  assert.deepEqual(names(result.definitions), ["valid"]);
  assert.equal(result.warnings[0]?.code, "unsupported-style-selector");
  assert.equal(result.coverage[0]?.status, "partial");
});

test("empty files and repeated declarations have explicit coverage and distinct locations", async () => {
  const result = await analyzeStyles([source("empty.module.sass", ""), source("global.css", ".a {}\n.a {}")]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(names(result.definitions), ["a", "a"]);
  assert.deepEqual(result.definitions.map(({ location }) => location.line), [1, 2]);
  assert.deepEqual(result.coverage, [
    { file: "empty.module.sass", scope: "module", status: "complete" },
    { file: "global.css", scope: "global", status: "complete" },
  ]);
  assert.deepEqual(await analyzeStyles([]), { definitions: [], coverage: [], warnings: [] });
});

test("output ordering is deterministic, serializable and does not mutate inputs", async () => {
  const inputs = Object.freeze([
    Object.freeze(source("z.scss", ".z {} .bad-#{$x} {}")),
    Object.freeze(source("A.module.css", ".a {}")),
    Object.freeze(source("a.scss", ".x-#{$y} {} .a {}")),
  ]);
  const result = await analyzeStyles(inputs);
  assert.deepEqual(await analyzeStyles([...inputs].reverse()), result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(result.warnings.map(({ location }) => location.file), ["a.scss", "z.scss"]);
});

test("excessive static expansion becomes an uncertainty warning and independent rules survive", async () => {
  const parents = Array.from({ length: 17 }, (_, index) => `.p${index}`).join(", ");
  const result = await analyzeStyles([source("styles.scss", `${parents} { & + & { .unproven {} } } .safe {}`)]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "unsupported-style-selector");
  assert.match(result.warnings[0]?.reason ?? "", /exceeds 256/);
  assert.ok(names(result.definitions).includes("safe"));
  assert.ok(!names(result.definitions).includes("unproven"));
  assert.equal(result.coverage[0]?.status, "partial");
});
