import type { ClassSymbol, Diagnostic, ProjectPath, SourceLocation } from "./contracts.js";

/** Normalize separators without silently resolving invalid/out-of-root paths. */
export function projectPath(value: string): ProjectPath {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Expected a root-relative file path: ${value}`);
  }
  return normalized as ProjectPath;
}

export function sourceLocation(file: ProjectPath, line: number, column?: number): SourceLocation {
  if (!Number.isSafeInteger(line) || line < 1) throw new Error("Line must be a positive integer");
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) {
    throw new Error("Column must be a positive integer");
  }
  return column === undefined ? { file, line } : { file, line, column };
}

/** Locale-independent ordering by UTF-16 code units. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Collision-safe key; no concatenation ambiguities with punctuation in file/class names. */
export function classSymbolKey(symbol: ClassSymbol): string {
  return JSON.stringify(
    symbol.scope === "global" ? ["global", symbol.name] : ["module", symbol.file, symbol.name],
  );
}

export function compareLocations(left: SourceLocation, right: SourceLocation): number {
  return (
    compareText(left.file, right.file) ||
    left.line - right.line ||
    (left.column ?? 0) - (right.column ?? 0)
  );
}

export function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareLocations(left.location, right.location) ||
    compareText(left.category, right.category) ||
    compareText(left.symbol ? classSymbolKey(left.symbol) : "", right.symbol ? classSymbolKey(right.symbol) : "") ||
    compareText(left.confidence, right.confidence) ||
    compareText(left.reason, right.reason)
  );
}
