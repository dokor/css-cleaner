import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import type { AnalysisReport } from "../src/contracts.js";
import { runCli } from "../src/cli/run.js";

// Tests run from .test-dist/tests, but exercise the actual package bin in dist/.
const executable = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const run = (args: readonly string[], cwd?: string) => {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: "utf8", cwd, timeout: 30_000 });
  assert.ifError(result.error);
  return result;
};
const fixtureBase = fileURLToPath(new URL("../../.verification/", import.meta.url));

async function fixture(t: TestContext, files: Readonly<Record<string, string>> = {}): Promise<string> {
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(join(fixtureBase, "cli project "));
  t.after(async () => {
    assert.equal(resolve(dirname(root)), resolve(fixtureBase));
    assert.ok(basename(root).startsWith("cli project "));
    await rm(root, { recursive: true, force: true });
  });
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

function jsonReport(text: string): AnalysisReport {
  const report = JSON.parse(text) as AnalysisReport;
  assert.equal(report.schemaVersion, 1);
  assert.ok(Array.isArray(report.diagnostics));
  assert.ok(Array.isArray(report.warnings));
  return report;
}

const missingFiles = {
  "src/Card.module.css": ".title { color: red; }\n.unused {}\n",
  "src/Card.tsx": 'import styles from "./Card.module.css";\nexport default () => <div className={styles.typo} />;\n',
};

test("the built executable exposes scan in its help", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: css-cleaner/);
    assert.match(result.stdout, /scan \[chemin\]/);
    assert.equal(result.stderr, "");
  }
});

test("scan help documents all options, exit codes and copyable examples without scanning", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run(["scan", "./nonexistent-project", flag]);
    assert.equal(result.status, 0);
    for (const option of ["--format", "--output", "--fail-on-missing"]) assert.ok(result.stdout.includes(option));
    assert.match(result.stdout, /terminal\|json\|markdown/);
    assert.match(result.stdout, /Codes de sortie/);
    assert.match(result.stdout, /css-cleaner scan \. --format markdown --output rapport\.md/);
    assert.equal(result.stderr, "");
  }
});

test("scan defaults to the current directory and terminal format, preserving sources in paths with spaces", async (t) => {
  const files = {
    ...missingFiles,
    "src/theme.scss": ".banner { &--active { color: red; } }\n",
    "src/Other.module.sass": ".secondary\n  color: blue\n",
    "src/Other.jsx": 'import styles from "./Other.module.sass";\nexport default () => <div className={styles.secondary} />;\n',
    "next.config.js": 'throw new Error("configuration must not execute");\n',
    "vite.config.ts": 'throw new Error("configuration must not execute");\n',
    "package.json": JSON.stringify({ scripts: { build: "must-not-build", start: "must-not-start" } }),
  };
  const root = await fixture(t, files);
  const result = run(["scan"], root);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^CSS Cleaner\n/);
  assert.match(result.stdout, /Scan complet/);
  assert.match(result.stdout, /src\/Card\.tsx:2:\d+/);
  assert.match(result.stdout, /module "typo" \(src\/Card.module.css\)/);
  assert.match(result.stdout, /\[undefined-class\]/);
  assert.match(result.stdout, /Confiance : high/);
  assert.match(result.stdout, /banner--active/);
  assert.doesNotMatch(result.stdout, /Other\.module\.sass/);
  for (const [file, content] of Object.entries(files)) assert.equal(await readFile(join(root, file), "utf8"), content);
});

test("JSON stdout parses directly and missing local classes fail only with the CI option", async (t) => {
  const root = await fixture(t, missingFiles);
  for (const failOnMissing of [false, true]) {
    const result = run(["scan", ".", "--format", "json", ...(failOnMissing ? ["--fail-on-missing"] : [])], root);
    assert.equal(result.status, failOnMissing ? 1 : 0);
    assert.equal(result.stderr, "");
    const report = jsonReport(result.stdout);
    assert.equal(report.completeness, "complete");
    const missing = report.diagnostics.find((diagnostic) => diagnostic.category === "undefined-class");
    assert.equal(missing?.confidence, "high");
    assert.deepEqual(missing?.symbol, { scope: "module", file: "src/Card.module.css", name: "typo" });
    assert.equal(missing?.location.file, "src/Card.tsx");
    assert.equal(missing?.location.line, 2);
    assert.ok(!result.stdout.includes(root));
  }
});

test("Markdown goes to stdout or the requested file, resolved from cwd rather than the scan root", async (t) => {
  const cwd = await fixture(t, { "target project/src/App.tsx": '<div className="absent" />;\n' });
  const args = ["scan", "--format", "markdown", "target project"];
  const terminal = run(args, cwd);
  assert.equal(terminal.status, 0);
  assert.equal(terminal.stderr, "");
  assert.match(terminal.stdout, /^# CSS Cleaner\n/);
  assert.match(terminal.stdout, /## Classes manquantes/);
  const saved = run([...args, "--output", "my report.md"], cwd);
  assert.equal(saved.status, 0);
  assert.equal(saved.stdout, "");
  assert.equal(saved.stderr, "");
  assert.equal(await readFile(join(cwd, "my report.md"), "utf8"), terminal.stdout);
});

test("output files contain the requested format, including when the CI exit code is 1", async (t) => {
  const root = await fixture(t, missingFiles);
  for (const format of ["terminal", "json", "markdown"]) {
    const stdout = run(["scan", root, `--format=${format}`], root);
    const result = run(["scan", root, "--format", format, "--output=report.txt", "--fail-on-missing"], root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const saved = await readFile(join(root, "report.txt"), "utf8");
    assert.equal(saved, stdout.stdout);
    if (format === "json") jsonReport(saved);
  }
});

test("dynamic-only, unused-only and empty scans succeed even with the CI option", async (t) => {
  for (const files of [
    { "src/Dynamic.tsx": 'export default ({ name }) => <div className={name} />;\n' },
    { "src/theme.css": ".unused {}\n" },
    {},
  ]) {
    const root = await fixture(t, files);
    const result = run(["scan", "--format", "json", "--fail-on-missing"], root);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const report = jsonReport(result.stdout);
    assert.ok(report.diagnostics.every((diagnostic) => diagnostic.category !== "undefined-class"));
    if ("src/Dynamic.tsx" in files) {
      assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.category), ["dynamic-usage"]);
    }
  }
});

test("configuration aliases, exclusions and external classes reach the full pipeline", async (t) => {
  const root = await fixture(t, {
    "css-cleaner.config.json": JSON.stringify({
      aliases: { "@/*": "src/*" }, exclude: ["src/Ignored.tsx"], externalGlobals: ["vendor"],
    }),
    "src/Card.module.scss": ".title { color: red; }\n",
    "src/Card.tsx": 'import styles from "@/Card.module.scss";\nexport default () => <><div className={styles.title} /><div className="vendor" /></>;\n',
    "src/Ignored.tsx": '<div className="absent" />;\n',
  });
  const result = run(["scan", ".", "--format", "json", "--fail-on-missing"], root);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(jsonReport(result.stdout).diagnostics, []);
});

test("warnings from discovery, styles and JSX retain their context without polluting JSON", async (t) => {
  const root = await fixture(t, {
    "src/Bad.module.css": ".bad {\n",
    "src/Bad.tsx": 'export default () => <div className="one";\n',
  });
  await symlink(join(root, "src"), join(root, "linked sources"), "junction");
  const result = run(["scan", ".", "--format", "json", "--fail-on-missing"], root);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const report = jsonReport(result.stdout);
  assert.equal(report.completeness, "partial");
  for (const [stage, code, file] of [
    ["discovery", "symlink-skipped", "linked sources"],
    ["styles", "style-syntax-error", "src/Bad.module.css"],
    ["jsx", "jsx-parse-error", "src/Bad.tsx"],
  ]) {
    const warning = report.warnings.find((entry) => entry.stage === stage && entry.code === code);
    assert.ok(warning, `${stage}: ${JSON.stringify(report.warnings)}`);
    assert.equal(warning.location.file, file);
    assert.ok(warning.location.line >= 1);
    assert.ok(warning.reason.length > 0);
  }
});

test("unresolved CSS Module imports remain diagnostics and do not fail CI", async (t) => {
  const root = await fixture(t, {
    "src/Card.tsx": 'import styles from "./Missing.module.css";\nexport default () => <div className={styles.title} />;\n',
  });
  const result = run(["scan", ".", "--format", "json", "--fail-on-missing"], root);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const diagnostic = jsonReport(result.stdout).diagnostics.find((entry) => entry.category === "unresolved-import");
  assert.ok(diagnostic);
  assert.equal(diagnostic.location.file, "src/Card.tsx");
  assert.match(diagnostic.reason, /Missing\.module\.css/);
});

test("absent roots, file roots and invalid configuration return contextual fatal errors", async (t) => {
  const root = await fixture(t, { "plain.txt": "not a directory", "css-cleaner.config.json": '{"exlude": []}' });
  for (const target of ["does not exist", "plain.txt", "."]) {
    const result = run(["scan", target, "--format", "json", "--fail-on-missing"], root);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(target === "." ? "css-cleaner.config.json:1" : target));
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    if (target === ".") assert.match(result.stderr, /exlude/);
  }
});

test("invalid scan options report usage errors with code 2 before scanning or writing", async (t) => {
  const root = await fixture(t);
  for (const args of [
    ["--unknown"], ["--format", "xml"], ["--format"], ["--format="], ["--output"], ["--output="],
    ["--output", "--format", "json"], ["--fail-on-missing=true"], ["one", "two"],
  ]) {
    const result = run(["scan", ...args], root);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /css-cleaner scan --help/);
  }
});

test("output write failures take precedence over CI findings and keep stdout empty", async (t) => {
  const root = await fixture(t, missingFiles);
  for (const file of ["missing parent/report.json", "src"]) {
    const result = run(["scan", ".", "--format", "json", "--output", file, "--fail-on-missing"], root);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Impossible d’écrire le rapport/);
    assert.ok(result.stderr.includes(file));
  }
});

test("output cannot overwrite a source or configuration, directly or through a link", async (t) => {
  // Windows loads the same config even if its filename uses different casing.
  const configName = process.platform === "win32" ? "CSS-CLEANER.config.json" : "css-cleaner.config.json";
  const files = { ...missingFiles, [configName]: "{}\n" };
  const root = await fixture(t, files);
  await link(join(root, "src/Card.module.css"), join(root, "linked-report.json"));
  await symlink(join(root, "src"), join(root, "linked src"), "junction");
  for (const file of [...Object.keys(files), "linked-report.json", "linked src/Card.module.css"]) {
    const result = run(["scan", ".", "--format", "json", "--output", file], root);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /source ou configuration/);
    for (const [source, content] of Object.entries(files)) assert.equal(await readFile(join(root, source), "utf8"), content);
  }
});

test("option terminator accepts a directory whose name starts with a dash", async (t) => {
  const cwd = await fixture(t, { "--project/src/App.tsx": "export default () => null;\n" });
  const result = run(["scan", "--format=json", "--", "--project"], cwd);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(jsonReport(result.stdout).diagnostics, []);
  // Also exercise a relative root with spaces from a different working directory.
  const relativeRoot = relative(cwd, join(cwd, "--project"));
  assert.equal(run(["scan", `./${relativeRoot}`], cwd).status, 0);
});

test("unknown commands and options return an actionable error", () => {
  for (const arg of ["unknown", "--unknown"]) {
    const result = run([arg]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /css-cleaner --help/);
  }
});

test("configured CI rules block unused classes while all report formats and raw confidence remain available", async (t) => {
  const config = JSON.stringify({ policy: { rules: { "unused-class": { severity: "error", minConfidence: "high" } } } });
  const root = await fixture(t, { "Card.module.css": ".unused {}\n", "css-cleaner.config.json": config });
  for (const format of ["terminal", "markdown", "json"]) {
    const result = run(["scan", root, "--format", format, "--output", "report.txt"], root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const text = await readFile(join(root, "report.txt"), "utf8");
    if (format === "json") {
      const report = jsonReport(text);
      assert.deepEqual(report.diagnostics.map((entry) => [entry.category, entry.confidence]), [["unused-class", "high"]]);
      assert.ok(!("severity" in report.diagnostics[0]!));
      assert.ok(!("policy" in report));
    } else {
      assert.match(text, /Politique CI : refusée/);
      assert.match(text, /Diagnostics bloquants : 1/);
      assert.match(text, /Gravité : (?:` )?error/);
    }
  }
  assert.equal(await readFile(join(root, "Card.module.css"), "utf8"), ".unused {}\n");
  assert.equal(await readFile(join(root, "css-cleaner.config.json"), "utf8"), config);
});

test("an error severity keeps low confidence and blocks only when the threshold explicitly permits it", async (t) => {
  const root = await fixture(t, {
    "Card.module.css": ".bad {\n",
    "Card.tsx": 'import s from "./Card.module.css"; export default () => <div className={s.typo} />;',
    "css-cleaner.config.json": JSON.stringify({ policy: { rules: { "undefined-class": { severity: "error" } } } }),
  });
  const cautious = run(["scan", root, "--format", "json"], root);
  assert.equal(cautious.status, 0);
  const strict = run(["scan", root, "--format", "json", "--rule", "undefined-class=error:low"], root);
  assert.equal(strict.status, 1);
  const report = jsonReport(strict.stdout);
  assert.equal(report.completeness, "partial");
  assert.equal(report.diagnostics.find((entry) => entry.category === "undefined-class")?.confidence, "low");
  assert.deepEqual(jsonReport(cautious.stdout), report);
  const readable = run(["scan", root], root);
  assert.equal(readable.status, 0);
  assert.match(readable.stdout, /Gravité : error/);
  assert.match(readable.stdout, /Confiance : low/);
  assert.match(readable.stdout, /Diagnostics bloquants : 0/);
});

test("CLI rules override file severity and activation while retaining an unspecified confidence threshold", async (t) => {
  const root = await fixture(t, {
    "Card.module.css": ".unused {}",
    "css-cleaner.config.json": JSON.stringify({ policy: { rules: { "unused-class": { severity: "error", minConfidence: "medium" } } } }),
  });
  for (const [args, expected] of [
    [[], 1], [["--rule", "unused-class=warning"], 0], [["--rule", "unused-class=off"], 0],
  ] as const) {
    const result = run(["scan", root, ...args], root);
    assert.equal(result.status, expected);
    assert.match(result.stdout, /Seuil CI : medium/);
    if (args.some((arg) => arg === "unused-class=off")) assert.match(result.stdout, /Règle : désactivée/);
  }
  await writeFile(join(root, "css-cleaner.config.json"), JSON.stringify({ policy: { rules: { "unused-class": { enabled: false, minConfidence: "medium" } } } }));
  const activated = run(["scan", root, "--rule", "unused-class=error"], root);
  assert.equal(activated.status, 1);
  assert.match(activated.stdout, /Règle : activée/);
  assert.match(activated.stdout, /Seuil CI : medium/);
});

test("completeness switches override the file without hiding partial analysis or warnings", async (t) => {
  const root = await fixture(t, {
    "Card.module.css": ".bad {\n",
    "css-cleaner.config.json": JSON.stringify({ policy: { requireComplete: true } }),
  });
  for (const [args, expected] of [
    [[], 1], [["--allow-partial"], 0], [["--require-complete", "--rule", "analysis-warning=off"], 1],
  ] as const) {
    const result = run(["scan", root, "--format", "json", ...args], root);
    assert.equal(result.status, expected);
    assert.equal(result.stderr, "");
    const report = jsonReport(result.stdout);
    assert.equal(report.completeness, "partial");
    assert.ok(report.warnings.length > 0);
  }
  await writeFile(join(root, "css-cleaner.config.json"), JSON.stringify({ policy: { requireComplete: false } }));
  const strict = run(["scan", root, "--require-complete"], root);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /Diagnostics bloquants : 0/);
  assert.match(strict.stdout, /Échec CI : analyse partielle/);
});

test("the legacy shortcut overrides a file rule and combines with explicit rules for other categories", async (t) => {
  const root = await fixture(t, {
    ...missingFiles,
    "css-cleaner.config.json": JSON.stringify({ policy: { rules: { "undefined-class": { enabled: false, severity: "info", minConfidence: "low" } } } }),
  });
  assert.equal(run(["scan", root], root).status, 0);
  const legacy = run(["scan", root, "--fail-on-missing", "--rule", "dynamic-usage=info"], root);
  assert.equal(legacy.status, 1);
  assert.match(legacy.stdout, /Gravité : error/);
  assert.match(legacy.stdout, /Seuil CI : high/);
});

test("malformed and conflicting policy options fail before discovery or output writes", async (t) => {
  const root = await fixture(t);
  const cases = [
    ["--rule", "missing=error"], ["--rule", "unused-class=fatal"], ["--rule", "unused-class=error:certain"],
    ["--rule", "unused-class=off:high"], ["--rule", "unused-class=error:"], ["--rule", "unused-class=error:high:low"],
    ["--rule", "unused-class"], ["--rule", "unused-class="], ["--rule", "=error"], ["--rule", "unused-class=error=low"],
    ["--rule", "unused-class=error", "--rule", "unused-class=off"],
    ["--require-complete", "--allow-partial"], ["--fail-on-missing", "--rule", "undefined-class=error:high"],
  ];
  for (const args of cases) {
    let stdout = "", stderr = "";
    const code = await runCli(["scan", join(root, "absent"), "--output", join(root, "report.json"), ...args], {
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    });
    assert.equal(code, 2, args.join(" "));
    assert.equal(stdout, "");
    assert.match(stderr, /css-cleaner scan --help/);
    assert.match(stderr, /--rule|policy|incompatibles|--fail-on-missing/);
    assert.doesNotMatch(stderr, /Cannot scan project/);
  }
  // Exercise the same conflict through the built binary as well.
  assert.equal(run(["scan", root, "--require-complete", "--allow-partial"], root).status, 2);
  await assert.rejects(readFile(join(root, "report.json")), { code: "ENOENT" });
});

test("invalid configured policy remains a localized fatal error even when CLI overrides it", async (t) => {
  const root = await fixture(t, {
    "css-cleaner.config.json": JSON.stringify({ policy: { rules: { "unused-class": { minConfidence: "certain" } } } }),
  });
  const result = run(["scan", root, "--format", "json", "--rule", "unused-class=error:high"], root);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /css-cleaner\.config\.json:1/);
  assert.match(result.stderr, /policy.rules.unused-class.minConfidence/);
});

test("policy summaries count warnings once and report write errors retain code 2", async (t) => {
  const root = await fixture(t, { "Card.module.css": ".bad {\n" });
  const args = ["scan", root, "--rule", "analysis-warning=error:low"];
  const result = run(args, root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Diagnostics bloquants : 1/);
  assert.match(result.stdout, /Avertissements : 1/);
  const writeError = run([...args, "--output", "missing/report.txt"], root);
  assert.equal(writeError.status, 2);
  assert.equal(writeError.stdout, "");
  assert.match(writeError.stderr, /Impossible d’écrire le rapport/);
});
