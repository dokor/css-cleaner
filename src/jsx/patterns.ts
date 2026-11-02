import ts from "typescript";
import type { ClassPatternPart } from "../contracts.js";

type Literal = { readonly kind: "literal"; readonly value: string; readonly offsets: readonly number[] };
type Unknown = { readonly kind: "unknown"; readonly expression: ts.Expression; readonly offset: number };
type Piece = Literal | Unknown;
type Token = { parts: ClassPatternPart[]; offset: number; expression?: ts.Expression };

/** Map cooked UTF-16 characters back to the original source, including JS escapes. */
export function literalParts(node: ts.StringLiteralLike | ts.TemplateLiteralToken, file: ts.SourceFile): Literal[] {
  const start = node.getStart(file) + 1;
  const end = node.end - (node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1);
  const offsets: number[] = [];
  const jsx = ts.isJsxAttribute(node.parent);
  for (let index = start; index < end; index++) {
    const offset = index;
    const character = file.text[index];
    if (!jsx && character === "\\") {
      const escaped = file.text[++index];
      if (escaped === "\r" || escaped === "\n") {
        if (escaped === "\r" && file.text[index + 1] === "\n") index++;
        continue;
      }
      if (escaped === "x") index += 2;
      else if (escaped === "u") {
        if (file.text[index + 1] === "{") {
          const close = file.text.indexOf("}", index + 2);
          if (close >= 0 && close < end) {
            if (Number.parseInt(file.text.slice(index + 2, close), 16) > 0xffff) offsets.push(offset);
            index = close;
          }
        } else index += 4;
      }
    } else if (!jsx && character === "\r" && file.text[index + 1] === "\n") index++;
    offsets.push(offset);
  }
  return [{ kind: "literal", value: node.text, offsets }];
}

export function templateParts(node: ts.TemplateExpression, file: ts.SourceFile): Piece[] {
  const pieces: Piece[] = literalParts(node.head, file);
  for (const span of node.templateSpans) {
    if (ts.isStringLiteralLike(span.expression)) pieces.push(...literalParts(span.expression, file));
    else pieces.push({ kind: "unknown", expression: span.expression, offset: span.expression.getStart(file) });
    pieces.push(...literalParts(span.literal, file));
  }
  return pieces;
}

/** Whitespace in known text separates class tokens; unknown fragments stay within a token. */
export function splitClassTokens(pieces: readonly Piece[]): Token[] {
  const tokens: Token[] = [];
  let current: Token | undefined;
  for (const piece of pieces) {
    if (piece.kind === "unknown") {
      current ??= { parts: [], offset: piece.offset, expression: piece.expression };
      if (current.parts.at(-1)?.kind !== "unknown") current.parts.push({ kind: "unknown" });
      // Only an isolated interpolation can keep a CSS Module reference.
      if (current.expression !== piece.expression) delete current.expression;
    } else {
      for (let index = 0; index < piece.value.length; index++) {
        const character = piece.value[index]!;
        if (/\s/u.test(character)) {
          if (current) tokens.push(current);
          current = undefined;
          continue;
        }
        current ??= { parts: [], offset: piece.offsets[index] ?? piece.offsets[0] ?? 0 };
        delete current.expression;
        const previous = current.parts.at(-1);
        if (previous?.kind === "literal") current.parts[current.parts.length - 1] = { kind: "literal", value: previous.value + character };
        else current.parts.push({ kind: "literal", value: character });
      }
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
