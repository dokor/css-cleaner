import selectorParser from "postcss-selector-parser";
import type { ClassDefinition, SourceLocation, StyleScope } from "../contracts.js";
import { classSymbolKey } from "../conventions.js";

interface Origin {
  readonly location: SourceLocation;
  readonly scope: StyleScope;
  readonly declared: boolean;
  readonly explicit: boolean;
}

export interface SelectorContext {
  readonly scope: StyleScope;
  /** An explicit :global/:local block also applies to a parent selector inside it. */
  readonly override?: StyleScope;
}

/** A bound keeps pathological selector lists from growing exponentially. */
const MAX_EXPANSIONS = 256;

/** Metadata travels with cloned selectors, so expanded BEM classes retain the '&' position. */
export class Selectors {
  private readonly origins = new WeakMap<selectorParser.Node, Origin>();
  private readonly overrides = new WeakMap<selectorParser.Node, StyleScope>();

  constructor(private readonly locationAt: (offset: number) => SourceLocation) {}

  parse(text: string, offset: number, context: SelectorContext): selectorParser.Selector[] {
    const root = selectorParser().astSync(text);
    if (("trailingComma" in root && root.trailingComma) || root.nodes.some((selector) => selector.nodes.length === 0)) {
      throw new Error("Empty selector in a selector list.");
    }
    for (const selector of root.nodes) this.annotate(selector, offset, context);
    return root.nodes;
  }

  private annotate(container: selectorParser.Root | selectorParser.Selector | selectorParser.Pseudo, offset: number, context: SelectorContext): void {
    let current = context;
    for (const node of container.nodes) {
      if (node.type === "pseudo" && (node.value === ":global" || node.value === ":local")) {
        const scope = node.value === ":global" ? "global" : "module";
        if (node.nodes.length > 0) {
          for (const child of node.nodes) this.annotate(child, offset, { scope, override: scope });
        } else {
          current = { scope, override: scope };
        }
      } else {
        if (node.type === "class" || node.type === "nesting") {
          this.origins.set(node, {
            scope: current.scope,
            location: this.locationAt(offset + node.sourceIndex),
            declared: true,
            explicit: current.override !== undefined,
          });
          if (node.type === "nesting" && current.override) this.overrides.set(node, current.override);
        }
        if ("nodes" in node) this.annotate(node, offset, current);
      }
    }
  }

  private clone<T extends selectorParser.Node>(node: T, inherited = false, scope?: StyleScope): T {
    const cloned = node.clone() as T;
    const copy = (original: selectorParser.Node, target: selectorParser.Node): void => {
      const origin = this.origins.get(original);
      if (origin) this.origins.set(target, { ...origin, scope: scope ?? origin.scope, declared: inherited ? false : origin.declared });
      const override = this.overrides.get(original);
      if (override) this.overrides.set(target, override);
      if ("nodes" in original && "nodes" in target) {
        original.nodes.forEach((child, index) => {
          const targetChild = target.nodes[index];
          if (targetChild) copy(child, targetChild);
        });
      }
    };
    copy(node, cloned);
    return cloned;
  }

  resolve(children: readonly selectorParser.Selector[], parents: readonly selectorParser.Selector[]): selectorParser.Selector[] {
    const resolved: selectorParser.Selector[] = [];
    for (const child of children) {
      let nestingCount = 0;
      child.walkNesting(() => { nestingCount++; });
      if (nestingCount === 0) {
        if (parents.length === 0) resolved.push(child);
        for (const parent of parents) {
          const combined = this.clone(parent, true);
          combined.append(selectorParser.combinator({ value: " " }));
          for (const node of child.nodes) combined.append(this.clone(node));
          resolved.push(combined);
          this.checkLimit(resolved.length);
        }
      } else {
        if (parents.length === 0) throw new Error("Parent selector '&' has no static parent.");
        let pending = [child];
        for (let index = 0; index < nestingCount; index++) {
          this.checkLimit(pending.length * parents.length + resolved.length);
          const next: selectorParser.Selector[] = [];
          for (const selector of pending) {
            for (const parent of parents) {
              const expanded = this.clone(selector);
              let nesting: selectorParser.Nesting | undefined;
              expanded.walkNesting((node) => { nesting = node; return false; });
              if (!nesting) throw new Error("Unresolved parent selector.");
              this.replaceParent(nesting, parent);
              next.push(expanded);
            }
          }
          pending = next;
        }
        resolved.push(...pending);
      }
      this.checkLimit(resolved.length);
    }
    for (const selector of resolved) this.applyBareScopes(selector);
    return resolved;
  }

  private applyBareScopes(container: selectorParser.Selector | selectorParser.Pseudo, inherited?: StyleScope): void {
    let scope = inherited;
    for (const node of container.nodes) {
      if (node.type === "pseudo") {
        if (node.nodes.length === 0 && (node.value === ":global" || node.value === ":local")) {
          scope = node.value === ":global" ? "global" : "module";
        } else {
          for (const child of node.nodes) this.applyBareScopes(child, scope);
        }
      } else if (node.type === "class" && scope) {
        const origin = this.origins.get(node);
        if (origin && !origin.explicit) this.origins.set(node, { ...origin, scope });
      }
    }
  }

  private replaceParent(nesting: selectorParser.Nesting, parent: selectorParser.Selector): void {
    const replacement = this.clone(parent, true, this.overrides.get(nesting));
    let suffix = nesting.next();
    while (suffix?.type === "comment") suffix = suffix.next();
    // The selector parser represents Sass '&__title' as a nesting node and a tag.
    if (suffix?.type === "tag") {
      const last = replacement.last;
      if (!last || (last.type !== "class" && last.type !== "id" && last.type !== "tag")) {
        throw new Error("Parent-selector suffix requires a static class, ID or type at the end of its parent.");
      }
      last.value += suffix.value;
      if (last.type === "class") {
        const origin = this.origins.get(nesting);
        const inherited = this.origins.get(last);
        if (origin && inherited) this.origins.set(last, { ...origin, scope: inherited.scope, declared: true });
      }
      suffix.remove();
    }
    if (replacement.first) replacement.first.spaces.before = nesting.spaces.before;
    nesting.replaceWith(...replacement.nodes);
  }

  private checkLimit(count: number): void {
    if (count > MAX_EXPANSIONS) throw new Error(`Static selector expansion exceeds ${MAX_EXPANSIONS} alternatives.`);
  }

  scopes(selectors: readonly selectorParser.Selector[]): StyleScope[] {
    const scopes = new Set<StyleScope>();
    for (const selector of selectors) selector.walkClasses((node) => {
      const origin = this.origins.get(node);
      if (origin) scopes.add(origin.scope);
    });
    return [...scopes];
  }

  definitions(selectors: readonly selectorParser.Selector[]): ClassDefinition[] {
    const definitions: ClassDefinition[] = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
      selector.walkClasses((node) => {
        const origin = this.origins.get(node);
        if (!origin?.declared) return;
        const symbol = origin.scope === "global"
          ? { scope: "global" as const, name: node.value }
          : { scope: "module" as const, file: origin.location.file, name: node.value };
        // Expansion repeats written tokens for many parents; preserve each original occurrence once.
        const key = JSON.stringify([classSymbolKey(symbol), origin.location.line, origin.location.column]);
        if (!seen.has(key)) {
          seen.add(key);
          definitions.push({ symbol, location: origin.location, selector: selector.toString().trim() });
        }
      });
    }
    return definitions;
  }
}
