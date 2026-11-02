import type { ClassNamePattern } from "../contracts.js";

/** Literal fragments are never interpreted as regular expressions or globs. */
export function compilePattern(pattern: ClassNamePattern): (name: string) => boolean {
  const segments = [""];
  for (const part of pattern.parts) {
    if (part.kind === "unknown") segments.push("");
    else segments[segments.length - 1] += part.value;
  }
  const prefix = segments[0] ?? "";
  if (segments.length === 1) return (name) => name === prefix;
  const suffix = segments[segments.length - 1] ?? "";
  const middle = segments.slice(1, -1);
  return (name) => {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
    const end = name.length - suffix.length;
    let offset = prefix.length;
    for (const literal of middle) {
      const index = name.indexOf(literal, offset);
      if (index < 0 || index + literal.length > end) return false;
      offset = index + literal.length;
    }
    return offset <= end;
  };
}

export function hasKnownFragment(pattern: ClassNamePattern): boolean {
  return pattern.parts.some((part) => part.kind === "literal" && part.value.length > 0);
}
