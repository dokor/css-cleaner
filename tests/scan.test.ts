import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DiscoveryError, getExitCode, projectPath, scanProject, ScanProjectError, sourceLocation } from "../src/index.js";
import type { AnalysisReport, DiscoveredProject, ScanProject, ScanProjectOptions, ScanProjectResult } from "../src/index.js";

const scan: ScanProject = scanProject;
const fixtureBase = fileURLToPath(new URL("../../.verification/", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const executable = join(packageRoot, "dist/cli/index.js");

async function fixture(t: TestContext, files: Readonly<Record<string, string>> = {}): Promise<string> {
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(join(fixtureBase, "scan project "));
  t.after(async () => {
    assert.equal(resolve(dirname(root)), resolve(fixtureBase));
    assert.ok(basename(root).startsWith("scan project "));
    await rm(root, { recursive: true, force: true });
  });
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

function snapshot(rootDir: string, css = ".title {}", access = "typo"): DiscoveredProject {
  return {
    config: { rootDir, include: ["**/*"], exclude: [], aliases: { "@/*": ["src/*"] }, externalGlobals: [] },
    styles: [{ file: projectPath("src/Card.module.css"), syntax: "css", scope: "module", content: css }],
    react: [{
      file: projectPath("src/Card.tsx"), syntax: "tsx",
      content: `import s from '@/Card.module.css';\r\nconst label = '😀'; export default () => <div className={s.${access}} />;\r\n`,
    }],
    warnings: [],
  };
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

const files = {
  "css-cleaner.config.json": JSON.stringify({ aliases: { "@/*": "src/*" }, externalGlobals: ["vendor"], exclude: ["src/Ignored.tsx"] }),
  "src/Card.module.scss": ".title {}\n.unused {}\n",
  "src/Card.tsx": 'import s from "@/Card.module.scss";\nexport default () => <><div className={s.typo} /><div className="vendor" /></>;\n',
  "src/Other.module.sass": ".title\n  color: blue\n",
  "src/Other.jsx": 'import s from "./Other.module.sass";\nexport default () => <div className={s.title} />;\n',
  "src/theme.css": ".button {}\n.button--primary {}\n",
  "src/Global.tsx": 'export default ({ variant }) => <div className={`button button--${variant}`} />;\n',
  "src/Ignored.tsx": '<div className="ignored" />;\n',
  "next.config.js": 'throw new Error("must not execute configuration");\n',
  "vite.config.ts": 'throw new Error("must not execute configuration");\n',
};

for (const partial of [false, true]) {
  test(`disk API and built CLI have identical ${partial ? "partial" : "complete"} reports and CI decisions`, async (t) => {
    const inputs = {
      ...files,
      ...(partial ? { "src/Bad.module.css": ".bad {\n", "src/Bad.tsx": '<div className="one";\n' } : {}),
    };
    const rootDir = await fixture(t, inputs);
    if (partial) await symlink(join(rootDir, "src"), join(rootDir, "linked sources"), "junction");
    const result: ScanProjectResult = await scan({ rootDir });
    const { report, project } = result;
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.completeness, partial ? "partial" : "complete");
    assert.equal(project.config.rootDir, resolve(rootDir));
    assert.ok(project.react.every((source) => source.file !== "src/Ignored.tsx"));
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.category === "undefined-class"));
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.category === "unused-class"));
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.category === "dynamic-usage"));
    if (partial) {
      for (const stage of ["discovery", "styles", "jsx"]) assert.ok(report.warnings.some((warning) => warning.stage === stage));
    }
    for (const failOnMissing of [false, true]) {
      const cli = spawnSync(process.execPath, [
        executable, "scan", rootDir, "--format", "json", ...(failOnMissing ? ["--fail-on-missing"] : []),
      ], { cwd: rootDir, encoding: "utf8", timeout: 30_000 });
      assert.ifError(cli.error);
      assert.equal(cli.stderr, "");
      assert.deepEqual(JSON.parse(cli.stdout) as AnalysisReport, report);
      assert.equal(cli.status, getExitCode({ status: "success", report }, { failOnMissing }));
    }
    assert.deepEqual((await scan({ snapshot: project })).report, report);
    for (const [file, content] of Object.entries(inputs)) assert.equal(await readFile(join(rootDir, file), "utf8"), content);
  });
}

test("discovery overrides are forwarded and the API has no console output, even on fatal errors", async (t) => {
  const rootDir = await fixture(t, { ...files, "app/Outside.tsx": '<div className="outside" />;' });
  const { project, report } = await scan({ rootDir, include: ["src/**"], exclude: ["src/Global.tsx"] });
  assert.deepEqual(project.react.map((source) => source.file), ["src/Card.tsx", "src/Other.jsx"]);
  assert.ok(!report.diagnostics.some((diagnostic) => diagnostic.category === "dynamic-usage"));
  // Self-import through the package exports exercises dist/, rather than the test build of src/.
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { scanProject, ScanProjectError } from 'css-cleaner';
    await scanProject({ rootDir: process.argv[1] });
    await assert.rejects(scanProject({ rootDir: process.argv[1] + '/absent' }), ScanProjectError);
  `, rootDir], { cwd: packageRoot, encoding: "utf8", timeout: 30_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("a frozen in-memory snapshot uses the real pipeline without accessing a project directory", async (t) => {
  const rootDir = join(await fixture(t), "not on disk");
  const input = snapshot(rootDir);
  const warning = {
    stage: "discovery", code: "snapshot-warning", reason: "Caller-provided coverage warning.",
    location: sourceLocation(projectPath("src/Card.module.css"), 1), affectedScopes: [{ scope: "module", file: projectPath("src/Card.module.css") }],
  } as const;
  const withWarning: DiscoveredProject = { ...input, warnings: [warning] };
  const before = structuredClone(withWarning);
  const options = { snapshot: freeze(withWarning) } satisfies ScanProjectOptions;
  const { report, project } = await scan(options);
  assert.deepEqual(withWarning, before);
  assert.notEqual(project, withWarning);
  assert.notEqual(project.config, withWarning.config);
  assert.deepEqual(project, withWarning);
  assert.equal(report.completeness, "partial");
  assert.ok(report.warnings.some((entry) => entry.code === "snapshot-warning"));
  const missing = report.diagnostics.find((diagnostic) => diagnostic.category === "undefined-class");
  assert.equal(missing?.symbol?.name, "typo");
  assert.equal(missing?.location.line, 2);
  assert.equal(missing.location.column, input.react[0]!.content.split("\r\n")[1]!.indexOf("s.typo") + 1);
  assert.ok(!JSON.stringify(report).includes(rootDir));
  await assert.rejects(stat(rootDir), { code: "ENOENT" });
});

test("a snapshot is captured before caller edits and scans keep concurrent projects isolated", async (t) => {
  const rootDir = await fixture(t);
  const first = snapshot(join(rootDir, "first"));
  const second = snapshot(join(rootDir, "second"), ".typo {}", "typo");
  const editable = { ...first, styles: [...first.styles], react: [...first.react] };
  const pending = scan({ snapshot: editable });
  editable.styles.length = 0;
  editable.react.length = 0;
  const [a, b] = await Promise.all([pending, scan({ snapshot: second })]);
  assert.deepEqual(a.project, first);
  assert.ok(a.report.diagnostics.some((diagnostic) => diagnostic.category === "undefined-class" && diagnostic.confidence === "high"));
  assert.deepEqual(b.report.diagnostics, []);
  assert.deepEqual(b.report.warnings, []);
  assert.deepEqual((await scan({ snapshot: first })).report, a.report);
});

test("empty snapshots succeed while syntax errors remain partial reports, not rejected scans", async (t) => {
  const input = snapshot(join(await fixture(t), "not on disk"));
  const empty = await scan({ snapshot: { ...input, styles: [], react: [] } });
  assert.deepEqual(empty.report, { schemaVersion: 1, completeness: "complete", diagnostics: [], warnings: [] });
  const broken = await scan({ snapshot: snapshot(input.config.rootDir, ".bad {") });
  assert.equal(broken.report.completeness, "partial");
  assert.ok(broken.report.warnings.some((warning) => warning.code === "style-syntax-error"));
});

test("fatal errors expose stable codes, stages, causes and source locations", async (t) => {
  const rootDir = await fixture(t, { "css-cleaner.config.json": '{"exlude": []}' });
  await assert.rejects(scan({ rootDir }), (error: unknown) => {
    assert.ok(error instanceof ScanProjectError);
    assert.equal(error.code, "invalid-config");
    assert.equal(error.stage, "discovery");
    assert.deepEqual(error.location, { file: "css-cleaner.config.json", line: 1 });
    assert.ok(error.cause instanceof DiscoveryError);
    return true;
  });
  for (const root of [join(rootDir, "absent"), join(rootDir, "css-cleaner.config.json"), ""]) {
    await assert.rejects(scan({ rootDir: root }), (error: unknown) => {
      assert.ok(error instanceof ScanProjectError);
      assert.equal(error.code, "invalid-root");
      assert.equal(error.stage, "discovery");
      assert.equal(error.location, undefined);
      return true;
    });
  }
});

test("JavaScript callers cannot mix discovery options and a snapshot", async () => {
  for (const options of [null, undefined, { snapshot: undefined }, { snapshot: snapshot("/virtual"), rootDir: "/other" }]) {
    await assert.rejects(scan(options as unknown as ScanProjectOptions), (error: unknown) => {
      assert.ok(error instanceof ScanProjectError);
      assert.equal(error.code, "invalid-options");
      assert.equal(error.stage, "discovery");
      return true;
    });
  }
});
