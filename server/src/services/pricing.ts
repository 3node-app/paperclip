// Local model pricing table for estimating USD cost from token counts.
//
// Why this exists: the Anthropic OAuth (Claude Max) plan bills against a flat
// subscription, not per request. The adapter therefore reports `costUsd = 0`
// with billingType `subscription_included`, so cost_events.cost_cents was always
// 0 — no cost visibility for the squad. To recover visibility we estimate the
// *equivalent metered-API price* from the token counts the adapter does report.
//
// IMPORTANT: a cost_cents value derived from this table is an ESTIMATE of the
// equivalent metered-API price, NOT an actual bill. Rows whose billingType is
// `metered_api` keep their real billed cost and are never overwritten by this
// estimate (see heartbeat.ts updateRuntimeState). The `billing_type` column lets
// consumers tell estimated rows apart from really-billed rows.
//
// Prices are USD per 1,000,000 tokens. Source of truth and update process:
//   docs/RUNBOOK-PRICING.md  (canonical: https://www.anthropic.com/pricing)
// Verified 2026-06-16 against the Anthropic model/pricing catalog.
//   - `cachedInput` is the cache-read price ≈ 0.1 × input (Anthropic prompt
//     caching: reads cost ~0.1× base input). The token field we price against
//     (cachedInputTokens) maps to cache-read tokens.
//
// Adding a new model is a one-line constant edit here — no migration needed.

export interface ModelPrice {
  /** USD per 1M input (uncached) tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read input tokens (~0.1 × input). */
  cachedInput: number;
}

export const PRICING_USD_PER_MILLION_TOKENS: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50, cachedInput: 1 },
  "claude-mythos-5": { input: 10, output: 50, cachedInput: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
};

/**
 * Resolve a pricing entry for a model id, tolerating the variants adapters emit:
 * provider prefixes (`anthropic.claude-…`), variant brackets (`…[1m]`), speed
 * suffixes (`…-fast`), and dated snapshots (`…-20251001`). Returns null when no
 * known model matches so callers can warn instead of guessing a price.
 */
export function resolveModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const raw = model.trim().toLowerCase();
  if (raw in PRICING_USD_PER_MILLION_TOKENS) return PRICING_USD_PER_MILLION_TOKENS[raw];

  let key = raw.includes(".") ? raw.slice(raw.indexOf(".") + 1) : raw;
  key = key.replace(/\[[^\]]*\]/g, ""); // strip variant brackets e.g. [1m]
  key = key.replace(/-fast$/, ""); // strip speed suffix
  key = key.replace(/-\d{8}$/, ""); // strip dated snapshot e.g. -20251001
  key = key.trim();
  if (key in PRICING_USD_PER_MILLION_TOKENS) return PRICING_USD_PER_MILLION_TOKENS[key];

  // Fall back to a prefix match so unanticipated suffixes still resolve.
  for (const known of Object.keys(PRICING_USD_PER_MILLION_TOKENS)) {
    if (key.startsWith(known)) return PRICING_USD_PER_MILLION_TOKENS[known];
  }
  return null;
}

export interface UsageForEstimate {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Estimate the equivalent metered-API cost in integer cents for a run's token
 * usage. Returns null when the model is unknown so the caller can log a warning
 * and leave cost_cents at 0 rather than crash.
 */
export function estimateCostCents(
  model: string | null | undefined,
  usage: UsageForEstimate,
): number | null {
  const price = resolveModelPrice(model);
  if (!price) return null;
  const cents =
    (usage.inputTokens / 1e6) * price.input * 100 +
    (usage.outputTokens / 1e6) * price.output * 100 +
    (usage.cachedInputTokens / 1e6) * price.cachedInput * 100;
  return Math.max(0, Math.round(cents));
}
