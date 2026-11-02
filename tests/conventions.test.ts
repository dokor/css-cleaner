import assert from "node:assert/strict";
import test from "node:test";
import type { Diagnostic } from "../src/contracts.js";
import { classSymbolKey, compareDiagnostics, compareText, projectPath, sourceLocation } from "../src/conventions.js";

test("project paths normalize Windows separators and preserve case", () => {
  assert.equal(projectPath("src\\Card.module.scss"), "src/Card.module.scss");
  for (const path of ["", "/tmp/style.css", "C:\\app\\style.css", "C:style.css", "../style.css", "src/../style.css", "./style.css", "src//style.css", "src/", "src/\0.css"]) {
    assert.throws(() => projectPath(path), /root-relative/);
  }
});

test("locations reject zero-based and non-integer coordinates", () => {
  const file = projectPath("src/App.tsx");
  assert.deepEqual(sourceLocation(file, 1), { file, line: 1 });
  assert.deepEqual(sourceLocation(file, 2, 3), { file, line: 2, column: 3 });
  for (const coordinate of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => sourceLocation(file, coordinate));
    assert.throws(() => sourceLocation(file, 1, coordinate));
  }
});

test("global and module symbols cannot collide, including delimiter characters", () => {
  const global = classSymbolKey({ scope: "global", name: "button" });
  const module = classSymbolKey({ scope: "module", file: projectPath("src/A.css"), name: "button" });
  assert.notEqual(global, module);
  assert.notEqual(
    classSymbolKey({ scope: "module", file: projectPath("src/a:b"), name: "c" }),
    classSymbolKey({ scope: "module", file: projectPath("src/a"), name: "b:c" }),
  );
});

test("diagnostic ordering is numeric for locations and independent of the locale", () => {
  const diagnostic = (file: string, line: number, column?: number): Diagnostic => ({
    category: "undefined-class", confidence: "high", reason: "fixture", candidates: [],
    location: sourceLocation(projectPath(file), line, column),
  });
  const expected = [diagnostic("src/A.tsx", 2), diagnostic("src/A.tsx", 2, 1), diagnostic("src/A.tsx", 10), diagnostic("src/Z.tsx", 1), diagnostic("src/a.tsx", 1)];
  assert.deepEqual([...expected].reverse().sort(compareDiagnostics), expected);
  assert.deepEqual(["é", "a", "Z"].sort(compareText), ["Z", "a", "é"]);
  const [first] = expected;
  assert.ok(first);
  const second = { ...first, category: "unused-class" } satisfies Diagnostic;
  assert.deepEqual([second, first].sort(compareDiagnostics), [first, second]);
});
