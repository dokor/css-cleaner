import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Tests run from .test-dist/tests, but exercise the actual package bin in dist/.
const executable = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [executable, ...args], { encoding: "utf8" });

test("the built executable exposes scan in its help", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = run(...args);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: css-cleaner/);
    assert.match(result.stdout, /scan \[chemin\]/);
    assert.equal(result.stderr, "");
  }
});

test("scan help describes the reserved command without performing an audit", () => {
  const result = run("scan", "--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Aucun audit/);
  assert.equal(result.stderr, "");
});

test("scan does not silently report success before the analysis is implemented", () => {
  const result = run("scan", "./nonexistent-project");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /pas encore implémentée/);
});

test("unknown commands and options return an actionable error", () => {
  for (const arg of ["unknown", "--unknown"]) {
    const result = run(arg);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /css-cleaner --help/);
  }
});
