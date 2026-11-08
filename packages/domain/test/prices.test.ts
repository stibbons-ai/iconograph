import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  DateString,
  derivePricing,
  needsRefresh,
  priceRefreshIntervalMs,
  pricingSpecs,
  resolvePrice,
  Unpriced,
  type PriceCandidates,
  type PriceFields,
} from "../src";

const now = new Date("2026-11-01T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

const llm = (input: number, output: number): PriceFields => ({
  input_cost_per_token: input,
  output_cost_per_token: output,
});
const override = { asOf: hoursAgo(1), fields: llm(1, 2) };
const litellm = { asOf: hoursAgo(2), fields: llm(3, 4) };
const snapshot = { asOf: hoursAgo(100), commit: "abc123", fields: llm(5, 6) };

const resolve = (candidates: Omit<PriceCandidates, "model" | "now">, model = "claude-sonnet-5-5") =>
  Effect.runSync(resolvePrice({ model, now, ...candidates }));
const unpriced = (
  candidates: Omit<PriceCandidates, "model" | "now">,
  model = "claude-sonnet-5-5",
) => Effect.runSync(Effect.flip(resolvePrice({ model, now, ...candidates })));

describe("price precedence", () => {
  test("a manual override beats cached LiteLLM data and the snapshot", () => {
    expect(resolve({ override, litellm, snapshot })).toEqual({
      model: "claude-sonnet-5-5",
      pricing: { _tag: "Llm", inputPerToken: 1, outputPerToken: 2 },
      source: { _tag: "override", asOf: hoursAgo(1).toISOString(), ageSeconds: 3600 },
    });
  });

  test("cached LiteLLM data beats the snapshot and reports its age", () => {
    expect(resolve({ litellm, snapshot })).toEqual({
      model: "claude-sonnet-5-5",
      pricing: { _tag: "Llm", inputPerToken: 3, outputPerToken: 4 },
      source: { _tag: "litellm", asOf: hoursAgo(2).toISOString(), ageSeconds: 7200, stale: false },
    });
  });

  test("a stale cache still beats the snapshot, flagged stale", () => {
    const stale = { asOf: hoursAgo(72), fields: llm(3, 4) };
    const quote = resolve({ litellm: stale, snapshot });
    expect(quote.pricing).toEqual({ _tag: "Llm", inputPerToken: 3, outputPerToken: 4 });
    expect(quote.source).toEqual({
      _tag: "litellm",
      asOf: hoursAgo(72).toISOString(),
      ageSeconds: 72 * 3600,
      stale: true,
    });
  });

  test("the snapshot answers only when no LiteLLM cache exists", () => {
    expect(resolve({ snapshot })).toEqual({
      model: "claude-sonnet-5-5",
      pricing: { _tag: "Llm", inputPerToken: 5, outputPerToken: 6 },
      source: {
        _tag: "snapshot",
        asOf: hoursAgo(100).toISOString(),
        ageSeconds: 100 * 3600,
        commit: "abc123",
      },
    });
  });

  test("a model missing from the cache is unpriced, never filled in from the snapshot", () => {
    const error = unpriced({ litellm: { asOf: hoursAgo(2) }, snapshot });
    expect(error).toBeInstanceOf(Unpriced);
    expect(error).toMatchObject({ _tag: "Unpriced", model: "claude-sonnet-5-5" });
    expect(error.message).toContain("not in the LiteLLM price data");
  });

  test("a model missing from the snapshot, with no cache, is unpriced", () => {
    const error = unpriced({ snapshot: { ...snapshot, fields: undefined } });
    expect(error).toMatchObject({ _tag: "Unpriced", model: "claude-sonnet-5-5" });
    expect(error.message).toContain("not in the bundled price snapshot");
  });

  test("a source missing a field the pricing mode needs is unpriced, not guessed", () => {
    const error = unpriced({
      litellm: { asOf: hoursAgo(2), fields: { input_cost_per_token: 1 } },
      snapshot,
    });
    expect(error.message).toBe(
      "No price for model claude-sonnet-5-5: Llm pricing needs output_cost_per_token",
    );
  });
});

// Field values are LiteLLM's at commit a1c5829f (2026-11-01).
describe("pricing modes", () => {
  const derive = (model: string, fields: PriceFields) =>
    Effect.runSync(derivePricing(model, fields));

  test("Gemini: per-image price, image-token price and the 2K price from 1680 image tokens", () => {
    const pricing = derive("gemini-nano-banana-2.1", {
      input_cost_per_token: 1.5e-6,
      output_cost_per_token: 7.5e-6,
      output_cost_per_image_token: 3e-5,
      output_cost_per_image: 0.0336,
    });
    expect(pricing).toMatchObject({
      _tag: "GeminiImage",
      inputPerToken: 1.5e-6,
      outputPerToken: 7.5e-6,
      outputPerImageToken: 3e-5,
      outputPerImage: 0.0336,
    });
    // Google lists $0.0504 per 2K image.
    expect(pricing._tag === "GeminiImage" && pricing.outputPer2KImage).toBeCloseTo(0.0504, 10);
  });

  test("OpenAI image models: text input, image input and image output tokens", () => {
    for (const model of ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]) {
      expect(
        derive(model, {
          input_cost_per_token: 5e-6,
          input_cost_per_image_token: 8e-6,
          output_cost_per_image_token: 3e-5,
        }),
      ).toEqual({
        _tag: "OpenAIImage",
        inputPerToken: 5e-6,
        inputPerImageToken: 8e-6,
        outputPerImageToken: 3e-5,
      });
    }
  });

  test("LLMs, including models outside the default set: input and output tokens", () => {
    for (const model of ["claude-sonnet-5-5", "some-configured-judge"]) {
      expect(derive(model, llm(2e-6, 1e-5))).toEqual({
        _tag: "Llm",
        inputPerToken: 2e-6,
        outputPerToken: 1e-5,
      });
    }
  });

  test("an OpenAI image model without image-token prices is unpriced", () => {
    const error = Effect.runSync(Effect.flip(derivePricing("gpt-image-2.6-flare", llm(1, 2))));
    expect(error.message).toBe(
      "No price for model gpt-image-2.6-flare: OpenAIImage pricing needs input_cost_per_image_token, output_cost_per_image_token",
    );
  });

  test("a Gemini image model without its text/thinking output price is unpriced", () => {
    const error = Effect.runSync(
      Effect.flip(
        derivePricing("gemini-nano-banana-2.1", {
          input_cost_per_token: 1.5e-6,
          output_cost_per_image_token: 3e-5,
          output_cost_per_image: 0.0336,
        }),
      ),
    );
    expect(error.message).toBe(
      "No price for model gemini-nano-banana-2.1: GeminiImage pricing needs output_cost_per_token",
    );
  });

  test("an unmapped model with image prices is unpriced rather than priced as an LLM", () => {
    const error = Effect.runSync(
      Effect.flip(
        derivePricing("some-new-image-model", {
          ...llm(1.5e-6, 7.5e-6),
          output_cost_per_image_token: 3e-5,
          output_cost_per_image: 0.0336,
        }),
      ),
    );
    expect(error.message).toBe(
      "No price for model some-new-image-model: output_cost_per_image_token, output_cost_per_image make it more than an LLM; map it in pricingSpecs, or override it without image fields only if it is a text-only LLM",
    );
  });

  test("every default model maps to a LiteLLM key; Gemini's 2K token count is a positive integer", () => {
    for (const spec of Object.values(pricingSpecs)) {
      expect(spec.litellmKey).not.toBe("");
      if (spec.mode === "GeminiImage") {
        expect(Number.isInteger(spec.outputTokensPer2KImage)).toBe(true);
        expect(spec.outputTokensPer2KImage).toBeGreaterThan(0);
      }
    }
  });
});

test("dates must be ISO 8601 date-times with a time zone", () => {
  const decode = Schema.decodeUnknownSync(DateString);
  for (const valid of [
    "2026-11-01T12:00:00Z",
    "2026-11-01T12:00:00.529Z",
    "2026-11-01T13:00:00+01:00",
  ]) {
    expect(decode(valid)).toBe(valid);
  }
  for (const lenient of [
    "1",
    "0",
    "Nov 1",
    "12/31",
    "2026-11-01",
    "2026-11-01T12:00:00",
    "2026-13-01T00:00:00Z",
  ]) {
    expect(() => decode(lenient)).toThrow("Expected an ISO 8601 date-time with a time zone");
  }
});

describe("refresh rule", () => {
  test("refresh when missing, at 24 h or older, or dated in the future", () => {
    expect(needsRefresh(undefined, now)).toBe(true);
    expect(needsRefresh(hoursAgo(0), now)).toBe(false);
    expect(needsRefresh(new Date(now.getTime() - priceRefreshIntervalMs + 1), now)).toBe(false);
    expect(needsRefresh(new Date(now.getTime() - priceRefreshIntervalMs), now)).toBe(true);
    expect(needsRefresh(hoursAgo(-1), now)).toBe(true);
    expect(needsRefresh(new Date(Number.NaN), now)).toBe(true);
  });
});
