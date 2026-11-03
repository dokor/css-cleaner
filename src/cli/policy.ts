import type { PolicyConfig } from "../contracts.js";
import { parsePolicyConfig } from "../policy/config.js";
import { resolvePolicy } from "../policy/index.js";

/** Parse category=severity[:confidence] overrides before any project IO. */
export function cliPolicy(
  specs: readonly string[], requireComplete: boolean, allowPartial: boolean, failOnMissing: boolean,
): PolicyConfig {
  if (requireComplete && allowPartial) throw new Error("--require-complete et --allow-partial sont incompatibles.");
  const rules = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    const [category, value, ...extra] = spec.split("=");
    if (!category || !value || extra.length > 0) throw new Error("--rule attend categorie=error|warning|info[:high|medium|low] ou categorie=off.");
    if (rules.has(category)) throw new Error(`--rule : catégorie répétée ${JSON.stringify(category)} ; préciser une seule règle par catégorie.`);
    const [severity, minConfidence, ...rest] = value.split(":");
    if (!severity || rest.length > 0 || (severity === "off" && minConfidence !== undefined)) {
      throw new Error(`--rule : valeur invalide ${JSON.stringify(value)} ; utilisez error|warning|info[:high|medium|low] ou off.`);
    }
    rules.set(category, severity === "off" ? { enabled: false } : {
      enabled: true, severity, ...(minConfidence === undefined ? {} : { minConfidence }),
    });
  }
  const overrides = parsePolicyConfig({
    ...(rules.size === 0 ? {} : { rules: Object.fromEntries(rules) }),
    ...(requireComplete || allowPartial ? { requireComplete } : {}),
  }, "CLI policy");
  resolvePolicy({}, overrides, { failOnMissing });
  return overrides;
}
