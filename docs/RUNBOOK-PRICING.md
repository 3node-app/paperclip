# Runbook — model pricing table

The cost-tracking pipeline converts per-run token counts into a USD estimate
using a hard-coded pricing table. This runbook explains why the table exists,
when it goes stale, and how to update it safely.

## Why a local table

The squad runs on the Anthropic OAuth (Claude Max) plan. That plan bills a flat
subscription, so the adapter reports `costUsd = 0` and `billingType =
subscription_included` for every run — there is no per-request USD to record.
To get cost **visibility** we estimate the *equivalent metered-API price* from
the token counts the adapter does report.

A `cost_cents` value produced this way is an **estimate of equivalent API
price, not an actual bill**. Rows with `billing_type = metered_api` keep their
real billed cost and are never overwritten by the estimate. Filter on
`billing_type` to separate estimated rows from really-billed rows.

## Where it lives

- Table + logic: `server/src/services/pricing.ts`
  (`PRICING_USD_PER_MILLION_TOKENS`, `resolveModelPrice`, `estimateCostCents`).
- Wiring: `server/src/services/heartbeat.ts` → `updateRuntimeState`. When the
  billed cost is 0 and the run has token usage, it falls back to
  `estimateCostCents`. Unknown models log a warning and leave `cost_cents = 0`
  (the run never crashes).
- Tests: `server/src/__tests__/pricing.test.ts`.

## Pricing source of truth

Canonical: <https://www.anthropic.com/pricing> (also
<https://platform.claude.com/docs/en/about-claude/models/overview>).

Prices are USD per 1,000,000 tokens. `cachedInput` is the cache-read price,
≈ 0.1 × input (Anthropic prompt caching: reads cost ~0.1× base input). The
token field priced against `cachedInput` is the run's cache-read tokens.

Current table (verified 2026-06-16):

| Model              | input | output | cachedInput |
| ------------------ | ----- | ------ | ----------- |
| claude-fable-5     | 10    | 50     | 1           |
| claude-mythos-5    | 10    | 50     | 1           |
| claude-opus-4-8    | 5     | 25     | 0.5         |
| claude-opus-4-7    | 5     | 25     | 0.5         |
| claude-opus-4-6    | 5     | 25     | 0.5         |
| claude-sonnet-4-6  | 3     | 15     | 0.3         |
| claude-haiku-4-5   | 1     | 5      | 0.1         |

> Note: the current Opus tier (4.6/4.7/4.8) is **$5 / $25**, not the older
> $15 / $75 that earlier Opus generations used. Re-confirm against the pricing
> page before changing these — a wrong base inflates every estimate.

## How to update

1. Open <https://www.anthropic.com/pricing> and read off input / output / cache-read
   prices per 1M tokens for each model in use.
2. Edit `PRICING_USD_PER_MILLION_TOKENS` in `server/src/services/pricing.ts`.
   Adding a model is a one-line constant — **no database migration is needed**.
3. Set `cachedInput` to the published cache-read price; if unpublished, use
   `0.1 × input`.
4. Update the "verified" date in `pricing.ts` and the table above.
5. Run `pnpm --filter @paperclipai/server test pricing` (or open a PR — CI runs it).

## Adding a model that adapters emit with a suffix

`resolveModelPrice` already tolerates provider prefixes (`anthropic.…`), variant
brackets (`…[1m]`), speed suffixes (`…-fast`), and dated snapshots
(`…-20251001`), plus a prefix fallback. You normally only need to add the base
model id. If a brand-new family appears with an unmatched shape, extend the
normalization in `resolveModelPrice` and add a test case.
