import { describe, expect, it } from "vitest";
import {
  PRICING_USD_PER_MILLION_TOKENS,
  estimateCostCents,
  resolveModelPrice,
} from "../services/pricing.js";

describe("resolveModelPrice", () => {
  it("resolves exact model ids", () => {
    expect(resolveModelPrice("claude-opus-4-8")).toEqual({ input: 5, output: 25, cachedInput: 0.5 });
    expect(resolveModelPrice("claude-fable-5")).toEqual({ input: 10, output: 50, cachedInput: 1 });
  });

  it("tolerates adapter variants (brackets, snapshots, prefixes, case)", () => {
    const opus = PRICING_USD_PER_MILLION_TOKENS["claude-opus-4-8"];
    expect(resolveModelPrice("claude-opus-4-8[1m]")).toEqual(opus);
    expect(resolveModelPrice("anthropic.claude-opus-4-8")).toEqual(opus);
    expect(resolveModelPrice("CLAUDE-OPUS-4-8")).toEqual(opus);
    expect(resolveModelPrice("claude-haiku-4-5-20251001")).toEqual(
      PRICING_USD_PER_MILLION_TOKENS["claude-haiku-4-5"],
    );
  });

  it("returns null for unknown models and empty input", () => {
    expect(resolveModelPrice("gpt-4o")).toBeNull();
    expect(resolveModelPrice(null)).toBeNull();
    expect(resolveModelPrice(undefined)).toBeNull();
    expect(resolveModelPrice("")).toBeNull();
  });
});

describe("estimateCostCents", () => {
  it("computes cents from input/output/cached token counts", () => {
    // Opus 4.8: $5/1M in, $25/1M out, $0.5/1M cached.
    // 1M in + 1M out + 1M cached = (5 + 25 + 0.5) USD = $30.50 = 3050 cents.
    expect(
      estimateCostCents("claude-opus-4-8", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
      }),
    ).toBe(3050);
  });

  it("rounds to the nearest cent and never goes negative", () => {
    // 100k output tokens on Haiku ($5/1M out) = $0.50 = 50 cents.
    expect(
      estimateCostCents("claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 100_000,
        cachedInputTokens: 0,
      }),
    ).toBe(50);
    expect(
      estimateCostCents("claude-opus-4-8", { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
    ).toBe(0);
  });

  it("returns a positive estimate for a realistic subscription run", () => {
    const cents = estimateCostCents("claude-opus-4-8", {
      inputTokens: 50_000,
      outputTokens: 8_000,
      cachedInputTokens: 200_000,
    });
    expect(cents).not.toBeNull();
    expect(cents).toBeGreaterThan(0);
  });

  it("returns null for an unknown model so the caller keeps cost_cents at 0", () => {
    expect(
      estimateCostCents("some-future-model", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 0,
      }),
    ).toBeNull();
  });
});
