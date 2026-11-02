import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { DiscoveredProject, StyleImportRequest } from "../src/contracts.js";
import { classSymbolKey, compareText, projectPath, sourceLocation } from "../src/conventions.js";
import { createStyleImportResolver, discoverProject, DiscoveryError } from "../src/discovery/index.js";
import type { CreateStyleImportResolver, DiscoverProject } from "../src/discovery/index.js";

const discover: DiscoverProject = discoverProject;
const resolverFor: CreateStyleImportResolver = createStyleImportResolver;
const fixtureBase = fileURLToPath(new URL("../../.verification/", import.meta.url));

async function fixture(t: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(join(fixtureBase, "discovery-"));
  t.after(async () => {
    // Only recursively remove this test's generated directory, never a project or parent.
    assert.equal(resolve(dirname(root)), resolve(fixtureBase));
    assert.ok(basename(root).startsWith("discovery-"));
    await rm(root, { recursive: true, force: true });
  });
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

function request(file: string, specifier: string, binding?: string): StyleImportRequest {
  return {
    specifier, location: sourceLocation(projectPath(file), 3, 8),
    ...(binding === undefined ? {} : { binding }),
  };
}

function styleContent(file: string): string {
  return file.endsWith(".sass")
    ? `// ${file}\n.title\n  color: red\n`
    : `/* ${file} */\n.title { color: red; }\n`;
}

for (const sourceDir of ["src", "app"]) {
  test(`discovers React JS/JSX/TS/TSX and all six style variants under ${sourceDir}/`, async (t) => {
    const styleNames = ["theme.sass", "Card.module.scss", "theme.css", "Card.module.sass", "theme.scss", "Card.module.css"];
    const reactNames = ["Page.tsx", "Page.js", "Page.ts", "Page.jsx"];
    const rootDir = await fixture(t, {
      ...Object.fromEntries(styleNames.map((file) => [`${sourceDir}/${file}`, styleContent(file)])),
      ...Object.fromEntries(reactNames.map((file) => [`${sourceDir}/${file}`, `// ${file}\nexport default () => null;\n`])),
      ".storybook/preview.ts": "export default {};",
      "unrelated.less": ".ignored {}",
      "README.md": "not source",
    });
    const result = await discover({ rootDir: relative(process.cwd(), rootDir) });
    assert.equal(result.config.rootDir, resolve(rootDir));
    assert.deepEqual(result.config.aliases, {});
    assert.deepEqual(result.config.externalGlobals, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.styles.map((style) => style.file), styleNames.map((file) => `${sourceDir}/${file}`).sort(compareText));
    assert.deepEqual(result.react.map((source) => source.file), [".storybook/preview.ts", ...reactNames.map((file) => `${sourceDir}/${file}`)].sort(compareText));
    for (const source of [...result.styles, ...result.react]) {
      assert.equal(source.syntax, source.file.split(".").at(-1));
      assert.ok(source.content.length > 0);
      assert.ok(!source.file.includes("\\"));
    }
    const resolveImport = resolverFor(result);
    for (const style of result.styles) {
      const expectedScope = style.file.includes(".module.") ? "module" : "global";
      assert.equal(style.scope, expectedScope);
      const importRequest = request(`${sourceDir}/Page.tsx`, `./${basename(style.file)}`);
      assert.deepEqual(await resolveImport(importRequest), {
        ...importRequest, status: "resolved", target: style.file, scope: expectedScope,
      });
      assert.equal(style.content, styleContent(basename(style.file)));
    }
    // No timestamps, host paths in sources or filesystem enumeration order leak into results.
    assert.deepEqual(await discover({ rootDir }), result);
  });
}

test("prunes dependency, version-control and generated directories at any depth", async (t) => {
  const ignored = [
    "node_modules", ".git", ".hg", ".svn", ".next", "dist", "coverage", "build", "out",
    ".turbo", ".cache", ".vercel", ".yarn", ".pnpm", ".pnpm-store", ".test-dist", "packages/widget/node_modules",
    "packages/widget/.next", "packages/widget/dist",
  ];
  const rootDir = await fixture(t, {
    ...Object.fromEntries(ignored.flatMap((directory) => [
      [`${directory}/Bad.tsx`, "must not be analyzed"], [`${directory}/Bad.module.css`, "must not be analyzed"],
    ])),
    "src/Keep.tsx": "keep", "src/Keep.module.css": ".keep {}",
  });
  // Even an explicit include cannot re-enable the built-in excluded directories.
  const result = await discover({ rootDir, include: ["**/*"] });
  assert.deepEqual(result.react.map((source) => source.file), ["src/Keep.tsx"]);
  assert.deepEqual(result.styles.map((source) => source.file), ["src/Keep.module.css"]);
});

test("loads declarative includes, additive exclusions, aliases and external class names/patterns", async (t) => {
  // This fixture documents the public JSON configuration format and its normalization.
  const rootDir = await fixture(t, {
    "css-cleaner.config.json": JSON.stringify({
      include: ["src/**/*.{tsx,css}"],
      exclude: ["src/generated/", "**/*.test.*"],
      aliases: { "@/*": ["missing/*", "./src/*"], "@styles": "src/styles", "@theme": "src/styles/theme.css", "~": "." },
      externalGlobals: ["thirdParty", { pattern: "vendor-*--active" }, { pattern: "*" }],
    }),
    "src/Page.tsx": "keep", "src/Page.jsx": "not included", "app/Page.tsx": "not included",
    "src/generated/Bad.tsx": "excluded", "src/Page.test.tsx": "excluded",
    "src/omit.css": "excluded by options", "src/styles/theme.css": ".theme {}",
  });
  const result = await discover({ rootDir, exclude: ["src/omit.css"] });
  assert.deepEqual(result.react.map((source) => source.file), ["src/Page.tsx"]);
  assert.deepEqual(result.styles.map((source) => source.file), ["src/styles/theme.css"]);
  assert.deepEqual(result.config.aliases, {
    "@/*": ["missing/*", "src/*"], "@styles": ["src/styles"], "@theme": ["src/styles/theme.css"], "~": ["."],
  });
  assert.deepEqual(result.config.externalGlobals, [
    { kind: "name", name: "thirdParty" },
    { kind: "pattern", pattern: { parts: [{ kind: "literal", value: "vendor-" }, { kind: "unknown" }, { kind: "literal", value: "--active" }] } },
    { kind: "pattern", pattern: { parts: [{ kind: "unknown" }] } },
  ]);
  const resolveImport = resolverFor(result);
  for (const specifier of ["@/styles/theme.css", "@styles/theme.css", "@theme", "~/src/styles/theme.css"]) {
    const input = request("src/Page.tsx", specifier);
    assert.deepEqual(await resolveImport(input), { ...input, status: "resolved", target: "src/styles/theme.css", scope: "global" });
  }
  assert.equal((await resolveImport(request("src/Page.tsx", "@styles-extra/theme.css"))).status, "unknown");
  // Programmatic includes replace the file's include; exclusions remain additive.
  const overridden = await discover({ rootDir, include: ["**/*.jsx", "**/*.test.tsx"] });
  assert.deepEqual(overridden.react.map((source) => source.file), ["src/Page.jsx"]);
  assert.deepEqual(overridden.styles, []);
  const empty = await discover({ rootDir, include: [] });
  assert.deepEqual(empty.react, []);
  assert.deepEqual(empty.styles, []);
});

test("relative homonymous imports retain module path identities and original request metadata", async (t) => {
  const rootDir = await fixture(t, {
    "src/Header/Card.module.css": ".title {}", "src/Footer/Card.module.css": ".title {}",
    "src/Header/Card.tsx": "", "src/Footer/Card.tsx": "",
  });
  const resolveImport = resolverFor(await discover({ rootDir }));
  const keys: string[] = [];
  for (const directory of ["Header", "Footer"]) {
    const input = request(`src\\${directory}\\Card.tsx`, ".\\Card.module.css", "styles");
    const result = await resolveImport(input);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") assert.fail("Expected resolved import");
    assert.deepEqual(result, { ...input, status: "resolved", target: `src/${directory}/Card.module.css`, scope: "module" });
    keys.push(classSymbolKey({ scope: "module", file: result.target, name: "title" }));
  }
  assert.notEqual(keys[0], keys[1]);
  const parent = request("src/Header/Card.tsx", "../Footer/Card.module.css");
  assert.deepEqual(await resolveImport(parent), { ...parent, status: "resolved", target: "src/Footer/Card.module.css", scope: "module" });
});

test("missing and excluded imports remain actionable unknown references", async (t) => {
  const rootDir = await fixture(t, {
    "css-cleaner.config.json": JSON.stringify({ exclude: ["src/Hidden.module.css"] }),
    "src/Page.tsx": "", "src/Hidden.module.css": ".hidden {}",
  });
  const resolveImport = resolverFor(await discover({ rootDir }));
  for (const file of ["Missing.module.css", "Hidden.module.css"]) {
    const input = request("src/Page.tsx", `./${file}`, "styles");
    const result = await resolveImport(input);
    assert.equal(result.status, "unknown");
    if (result.status !== "unknown") assert.fail("Expected unresolved import");
    assert.deepEqual(result.location, input.location);
    assert.equal(result.specifier, input.specifier);
    assert.equal(result.binding, "styles");
    assert.match(result.reason, /missing, excluded/u);
    assert.deepEqual(result.candidates, [`src/${file}`]);
  }
  for (const specifier of ["../../../outside.module.css", "vendor/Card.module.css", "./Hidden.module.css?inline", "./Hidden.module.css#fragment", ""]) {
    const result = await resolveImport(request("src/Page.tsx", specifier));
    assert.equal(result.status, "unknown");
    if (result.status !== "unknown") assert.fail("Expected unresolved import");
    assert.ok(result.reason.length > 0);
    assert.deepEqual(result.candidates, []);
  }
});

test("resolver runs from an in-memory catalogue and exposes extension ambiguity deterministically", async () => {
  const project: DiscoveredProject = {
    config: {
      rootDir: resolve("does-not-need-to-exist"), include: [], exclude: [], externalGlobals: [],
      aliases: {
        "@/*": ["src/*"], "@/theme": ["src/special.css"],
        "@/deep/*": ["src/*"], "@suffix/*.css": ["src/*.scss"],
      },
    },
    styles: [
      { file: projectPath("src/Card.module.scss"), syntax: "scss", scope: "module", content: "" },
      { file: projectPath("src/Card.module.sass"), syntax: "sass", scope: "module", content: "" },
      { file: projectPath("src/special.css"), syntax: "css", scope: "global", content: "" },
      { file: projectPath("src/theme.css"), syntax: "css", scope: "global", content: "" },
      { file: projectPath("src/folder/index.css"), syntax: "css", scope: "global", content: "" },
      { file: projectPath("src/Cash$&.css"), syntax: "css", scope: "global", content: "" },
      { file: projectPath("index.css"), syntax: "css", scope: "global", content: "" },
    ],
    react: [], warnings: [],
  };
  const resolveImport = resolverFor(project);
  const ambiguous = await resolveImport(request("src/Page.tsx", "./Card.module"));
  assert.equal(ambiguous.status, "unknown");
  if (ambiguous.status !== "unknown") assert.fail("Expected ambiguous import");
  assert.match(ambiguous.reason, /Several/u);
  assert.deepEqual(ambiguous.candidates, ["src/Card.module.sass", "src/Card.module.scss"]);
  assert.deepEqual(await resolverFor({ ...project, styles: [...project.styles].reverse() })(request("src/Page.tsx", "./Card.module")), ambiguous);
  for (const [specifier, target] of [
    ["@/theme", "src/special.css"], ["@/deep/theme.css", "src/theme.css"],
    ["@suffix/Card.module.css", "src/Card.module.scss"], ["./folder", "src/folder/index.css"],
    ["./folder/", "src/folder/index.css"], ["@/Cash$&.css", "src/Cash$&.css"],
  ] as const) {
    const result = await resolveImport(request("src/Page.tsx", specifier));
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") assert.fail("Expected resolved import");
    assert.equal(result.target, target);
  }
  for (const specifier of ["./", "./a/../"]) {
    const input = request("Page.tsx", specifier);
    assert.deepEqual(await resolveImport(input), { ...input, status: "resolved", target: "index.css", scope: "global" });
  }
  const invalidDirectory = await resolveImport(request("Page.tsx", "./theme.css/"));
  assert.equal(invalidDirectory.status, "unknown");
  if (invalidDirectory.status !== "unknown") assert.fail("Expected unknown directory import");
  assert.deepEqual(invalidDirectory.candidates, ["theme.css/index.css", "theme.css/index.sass", "theme.css/index.scss"]);
});

test("skips directory links without recursing through cycles and reports discovery uncertainty", async (t) => {
  const rootDir = await fixture(t, { "src/Card.module.css": ".title {}" });
  await symlink(rootDir, join(rootDir, "Z-cycle"), "junction");
  await symlink(join(rootDir, "src"), join(rootDir, "A-linked"), "junction");
  // Pruning happens before following any dependency entry, even a link back to the root.
  await symlink(rootDir, join(rootDir, "node_modules"), "junction");
  const result = await discover({ rootDir });
  assert.deepEqual(result.styles.map((style) => style.file), ["src/Card.module.css"]);
  assert.deepEqual(result.warnings.map((warning) => warning.location.file), ["A-linked", "Z-cycle"]);
  for (const warning of result.warnings) {
    assert.equal(warning.stage, "discovery");
    assert.equal(warning.code, "symlink-skipped");
    assert.deepEqual(warning.affectedScopes, [{ scope: "project" }]);
  }
  assert.equal((await resolverFor(result)(request("src/Page.tsx", "../A-linked/Card.module.css"))).status, "unknown");
});

test("JSON may contain a UTF-8 BOM; executable configuration is never loaded", async (t) => {
  const rootDir = await fixture(t, {
    "css-cleaner.config.json": '\uFEFF{"externalGlobals":[{"pattern":"vendor-**"}]}',
    "css-cleaner.config.js": 'throw new Error("must never execute")',
  });
  const result = await discover({ rootDir });
  assert.deepEqual(result.config.externalGlobals, [{
    kind: "pattern", pattern: { parts: [{ kind: "literal", value: "vendor-" }, { kind: "unknown" }] },
  }]);
  assert.equal(result.react[0]?.file, "css-cleaner.config.js");
});

const invalidConfigs: readonly [string, string][] = [
  ["{", "JSON"], ["null", "configuration"], ["[]", "configuration"],
  ['{"exlude":[]}', "exlude"], ['{"include":"src/**"}', "include"],
  ['{"exclude":["../outside/**"]}', "exclude[0]"], ['{"include":["/absolute/**"]}', "include[0]"],
  ['{"include":["C:\\\\absolute\\\\**"]}', "include[0]"], ['{"exclude":["!src/**"]}', "exclude[0]"],
  ['{"include":["src/["]}', "include[0]"], ['{"include":[""]}', "include[0]"],
  ['{"aliases":[]}', "aliases"], ['{"aliases":{"@/*":[]}}', 'aliases["@/*"]'],
  ['{"aliases":{"@/*":"../outside/*"}}', 'aliases["@/*"][0]'],
  ['{"aliases":{"@/**":"src/*"}}', 'aliases["@/**"]'],
  ['{"aliases":{"@":"src/*"}}', 'aliases["@"][0]'],
  ['{"aliases":{"@":123}}', 'aliases["@"][0]'],
  ['{"externalGlobals":"vendor"}', "externalGlobals"], ['{"externalGlobals":["two classes"]}', "externalGlobals[0]"],
  ['{"externalGlobals":[{"pattern":42}]}', "externalGlobals[0].pattern"],
  ['{"externalGlobals":[{"pattern":"vendor-*","typo":true}]}', "typo"],
];

test("invalid configuration yields a typed fatal error with file, field and CLI-readable reason", async (t) => {
  for (const [content, field] of invalidConfigs) {
    const rootDir = await fixture(t, { "css-cleaner.config.json": content });
    await assert.rejects(discover({ rootDir }), (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.code, "invalid-config");
      assert.equal(error.name, "DiscoveryError");
      assert.ok(error.message.includes("css-cleaner.config.json"));
      assert.ok(error.message.includes(field), `${content}: ${error.message}`);
      assert.deepEqual(error.location, { file: "css-cleaner.config.json", line: 1 });
      return true;
    });
  }
});

test("invalid scan roots and unreadable config paths fail without pretending discovery succeeded", async (t) => {
  const rootDir = await fixture(t, { "file.txt": "not a directory" });
  for (const path of ["", join(rootDir, "missing"), join(rootDir, "file.txt")]) {
    await assert.rejects(discover({ rootDir: path }), (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.code, "invalid-root");
      return true;
    });
  }
  await mkdir(join(rootDir, "css-cleaner.config.json"));
  await assert.rejects(discover({ rootDir }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryError);
    assert.equal(error.code, "unreadable-config");
    assert.equal(error.location?.file, "css-cleaner.config.json");
    return true;
  });
});
