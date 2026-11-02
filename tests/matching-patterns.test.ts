import assert from "node:assert/strict";
import test from "node:test";
import type { ClassNamePattern, ClassPatternPart } from "../src/contracts.js";
import { compilePattern } from "../src/matching/patterns.js";

function pattern(...fragments: [string | null, ...(string | null)[]]): ClassNamePattern {
  return { parts: fragments.map((fragment): ClassPatternPart => fragment === null ?
    { kind: "unknown" } : { kind: "literal", value: fragment }) as [ClassPatternPart, ...ClassPatternPart[]] };
}

const cases: readonly [string, ClassNamePattern, readonly string[], readonly string[]][] = [
  ["literal fragments", pattern("a", "bc"), ["abc"], ["ab", "abcd", "ABC"]],
  ["unknown matches zero or more characters", pattern("button--", null), ["button--", "button--primary"], ["xbutton--primary", "link--primary"]],
  ["suffix anchoring with repeated fragments", pattern(null, "a"), ["a", "aba"], ["ab", ""]],
  ["prefix and suffix cannot overlap", pattern("ab", null, "bc"), ["abbc", "abXbc"], ["abc", "abXbcX"]],
  ["multiple ordered unknowns", pattern("b", null, "--", null, "-active"), ["b---active", "button--primary-active"], ["b--active", "button-active--primary", "xbutton--primary-active"]],
  ["consecutive unknowns and empty literals", pattern(null, "", null), ["", "anything", "é😀", "a\nb"], []],
  ["metacharacters remain literal", pattern("a[.*]+?($^|\\", null, ")"), ["a[.*]+?($^|\\)"], ["abc", "a.*)"]],
  ["unicode is preserved", pattern("é", null, "😀"), ["é😀", "é-X-😀"], ["e😀", "é😀x"]],
];

for (const [description, value, accepted, rejected] of cases) {
  test(`class patterns: ${description}`, () => {
    const matches = compilePattern(value);
    for (const name of accepted) assert.equal(matches(name), true, `Expected ${JSON.stringify(name)} to match`);
    for (const name of rejected) assert.equal(matches(name), false, `Expected ${JSON.stringify(name)} not to match`);
  });
}

test("many unknown fragments are matched without regular expression backtracking", () => {
  const value = pattern(null, ...Array.from({ length: 100 }, () => ["a", null] as const).flat(), "z");
  assert.equal(compilePattern(value)("a".repeat(10000)), false);
});
