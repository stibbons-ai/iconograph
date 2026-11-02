import { Effect, Schema } from "effect";

/** A price in USD per unit (token or image); never negative. */
const Usd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 date-time with a time zone, e.g. `2026-11-01T12:00:00.000Z`. */
export const DateString = Schema.String.check(
  Schema.makeFilter((value: string) =>
    isoDateTime.test(value) && Number.isFinite(Date.parse(value))
      ? true
      : "Expected an ISO 8601 date-time with a time zone",
  ),
);

/**
 * The price fields we read from one LiteLLM model entry, under LiteLLM's own
 * key names, all in USD. The LiteLLM cache, the bundled snapshot and manual
 * overrides all store this shape; `derivePricing` turns it into a pricing mode.
 *
 * Standard rates only: cache (`cache_read_input_token_cost`, …), batch and
 * long-context tiers (`*_above_200k_tokens`) are ignored. Vendors may discount
 * cached input automatically, so these prices are upper bounds; batch calls and
 * contexts over 200k tokens are assumed unused.
 */
export const PriceFields = Schema.Struct({
  input_cost_per_token: Schema.optionalKey(Usd),
  output_cost_per_token: Schema.optionalKey(Usd),
  input_cost_per_image_token: Schema.optionalKey(Usd),
  output_cost_per_image_token: Schema.optionalKey(Usd),
  output_cost_per_image: Schema.optionalKey(Usd),
});
export type PriceFields = typeof PriceFields.Type;

/** A language model (Judge, Optimizer): USD per input and per output token. */
export const LlmPricing = Schema.TaggedStruct("Llm", {
  inputPerToken: Usd,
  outputPerToken: Usd,
});

/** An OpenAI image model: text input tokens, image input tokens and image output tokens. */
export const OpenAIImagePricing = Schema.TaggedStruct("OpenAIImage", {
  inputPerToken: Usd,
  inputPerImageToken: Usd,
  outputPerImageToken: Usd,
});

/**
 * A Gemini image model. Input text and images are billed as input tokens;
 * output text and thinking per `outputPerToken`, output images per image token.
 * `outputPerImage` is LiteLLM's per-image price, which was Google's 1K price as
 * of LiteLLM commit a1c5829 (2026-11-01). `outputPer2KImage` is derived from
 * image-token pricing, since Lanes generate 2K.
 */
export const GeminiImagePricing = Schema.TaggedStruct("GeminiImage", {
  inputPerToken: Usd,
  outputPerToken: Usd,
  outputPerImageToken: Usd,
  outputPerImage: Usd,
  outputPer2KImage: Usd,
});
export type GeminiImagePricing = typeof GeminiImagePricing.Type;

export const Pricing = Schema.Union([LlmPricing, OpenAIImagePricing, GeminiImagePricing]);
export type Pricing = typeof Pricing.Type;

/** How a model is billed, and the LiteLLM key holding its prices. */
export type PricingSpec =
  | { readonly mode: "Llm" | "OpenAIImage"; readonly litellmKey: string }
  | {
      readonly mode: "GeminiImage";
      readonly litellmKey: string;
      /** Image tokens one 2K output image consumes, from Google's pricing page. */
      readonly outputTokensPer2KImage: number;
    };

/**
 * The models Iconograph uses by default, mapped explicitly to LiteLLM keys.
 * `gemini/…` is LiteLLM's Gemini Developer API entry; the bare Gemini key is Vertex AI.
 */
export const pricingSpecs: Readonly<Record<string, PricingSpec>> = {
  "gemini-nano-banana-2.1": {
    mode: "GeminiImage",
    litellmKey: "gemini/gemini-nano-banana-2.1",
    // https://ai.google.dev/gemini-api/docs/pricing#gemini-nano-banana-2.1
    outputTokensPer2KImage: 1680,
  },
  "gpt-image-2.5-sunburst": { mode: "OpenAIImage", litellmKey: "gpt-image-2.5-sunburst" },
  "gpt-image-2.5-flare": { mode: "OpenAIImage", litellmKey: "gpt-image-2.5-flare" },
  "claude-sonnet-5-5": { mode: "Llm", litellmKey: "claude-sonnet-5-5" },
};

/**
 * Any other model (e.g. a configured Judge) is an LLM looked up under its own
 * id, unless its prices include image fields (see `pricingProblem`).
 */
export function pricingSpec(model: string): PricingSpec {
  return Object.hasOwn(pricingSpecs, model)
    ? pricingSpecs[model]!
    : { mode: "Llm", litellmKey: model };
}

/** No usable price for a model, so it must not be used: a Run can't start unpriced. */
export class Unpriced extends Schema.TaggedError<Unpriced>()("Unpriced", {
  model: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `No price for model ${this.model}: ${this.reason}`;
  }
}

const required: Record<Pricing["_tag"], ReadonlyArray<keyof PriceFields>> = {
  Llm: ["input_cost_per_token", "output_cost_per_token"],
  OpenAIImage: [
    "input_cost_per_token",
    "input_cost_per_image_token",
    "output_cost_per_image_token",
  ],
  GeminiImage: [
    "input_cost_per_token",
    "output_cost_per_token",
    "output_cost_per_image_token",
    "output_cost_per_image",
  ],
};

const imageFields = [
  "input_cost_per_image_token",
  "output_cost_per_image_token",
  "output_cost_per_image",
] as const;

/**
 * Why these fields can't price this model, or undefined if they can: a field
 * its mode needs is missing, or an unmapped model has image prices (pricing it
 * as an LLM would leave its image costs out of the Budget).
 */
export function pricingProblem(model: string, fields: PriceFields): string | undefined {
  const spec = pricingSpec(model);
  const missing = required[spec.mode].filter((name) => fields[name] === undefined);
  if (missing.length > 0) return `${spec.mode} pricing needs ${missing.join(", ")}`;
  if (!Object.hasOwn(pricingSpecs, model)) {
    const images = imageFields.filter((name) => fields[name] !== undefined);
    if (images.length > 0) {
      return `${images.join(", ")} make it more than an LLM; map it in pricingSpecs, or override it without image fields only if it is a text-only LLM`;
    }
  }
  return undefined;
}

/**
 * Derive a model's pricing mode from its price fields. Never invents a price:
 * fields that `pricingProblem` rejects make the model `Unpriced`.
 */
export function derivePricing(
  model: string,
  fields: PriceFields,
): Effect.Effect<Pricing, Unpriced> {
  const problem = pricingProblem(model, fields);
  if (problem !== undefined) return Effect.fail(new Unpriced({ model, reason: problem }));
  const spec = pricingSpec(model);
  const f = fields as Required<PriceFields>;
  switch (spec.mode) {
    case "Llm":
      return Effect.succeed(
        LlmPricing.make({
          inputPerToken: f.input_cost_per_token,
          outputPerToken: f.output_cost_per_token,
        }),
      );
    case "OpenAIImage":
      return Effect.succeed(
        OpenAIImagePricing.make({
          inputPerToken: f.input_cost_per_token,
          inputPerImageToken: f.input_cost_per_image_token,
          outputPerImageToken: f.output_cost_per_image_token,
        }),
      );
    case "GeminiImage":
      return Effect.succeed(
        GeminiImagePricing.make({
          inputPerToken: f.input_cost_per_token,
          outputPerToken: f.output_cost_per_token,
          outputPerImageToken: f.output_cost_per_image_token,
          outputPerImage: f.output_cost_per_image,
          outputPer2KImage: f.output_cost_per_image_token * spec.outputTokensPer2KImage,
        }),
      );
  }
}

/** LiteLLM data older than this is refreshed; until a refresh succeeds it is still served. */
export const priceRefreshIntervalMs = 24 * 60 * 60 * 1000;

/**
 * True when there is no cache, it is 24 h old or more, it is dated in the
 * future (the clock moved back), or its date is invalid.
 */
export function needsRefresh(fetchedAt: Date | undefined, now: Date): boolean {
  if (fetchedAt === undefined) return true;
  const age = now.getTime() - fetchedAt.getTime();
  return !Number.isFinite(age) || age < 0 || age >= priceRefreshIntervalMs;
}

const Age = {
  /** When the override was set, or when the price data was fetched (ISO 8601). */
  asOf: DateString,
  /** Clamped to 0 for a date in the future. */
  ageSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

/** Where a quoted price came from, and how old it is. */
export const PriceOrigin = Schema.Union([
  Schema.TaggedStruct("override", Age),
  /** `stale`: 24 h old or more, or dated in the future; `needsRefresh` would refetch it. */
  Schema.TaggedStruct("litellm", { ...Age, stale: Schema.Boolean }),
  Schema.TaggedStruct("snapshot", { ...Age, commit: Schema.String }),
]);
export type PriceOrigin = typeof PriceOrigin.Type;

export const PriceQuote = Schema.Struct({
  model: Schema.String,
  pricing: Pricing,
  source: PriceOrigin,
});
export type PriceQuote = typeof PriceQuote.Type;

/** One source's entry for the model being priced; `fields` is absent when the source lacks it. */
export interface PriceEntry {
  readonly asOf: Date;
  readonly fields?: PriceFields | undefined;
}

export interface PriceCandidates {
  readonly model: string;
  readonly now: Date;
  /** The operator's override for this model, if any. */
  readonly override?: PriceEntry | undefined;
  /** The cached LiteLLM data, if it was ever fetched, however old. */
  readonly litellm?: PriceEntry | undefined;
  /** The bundled snapshot, used only before the first successful fetch. */
  readonly snapshot: PriceEntry & { readonly commit: string };
}

/**
 * Pick a model's price: manual override > cached LiteLLM > bundled snapshot.
 *
 * A LiteLLM cache always wins over the snapshot, even when stale (24 h old or
 * more, or dated in the future): its age is reported instead, and a model
 * missing from it is `Unpriced`. The snapshot is consulted only when no cache
 * exists at all.
 */
export function resolvePrice(candidates: PriceCandidates): Effect.Effect<PriceQuote, Unpriced> {
  const { model, now, override, litellm, snapshot } = candidates;
  const age = (asOf: Date) => ({
    asOf: asOf.toISOString(),
    ageSeconds: Math.max(0, Math.floor((now.getTime() - asOf.getTime()) / 1000)),
  });
  const quote = (
    entry: PriceEntry,
    source: PriceOrigin,
    described: string,
  ): Effect.Effect<PriceQuote, Unpriced> =>
    entry.fields === undefined
      ? Effect.fail(new Unpriced({ model, reason: `not in the ${described}` }))
      : Effect.map(derivePricing(model, entry.fields), (pricing) => ({ model, pricing, source }));

  if (override) {
    return quote(override, { _tag: "override", ...age(override.asOf) }, "override");
  }
  if (litellm) {
    const source = {
      _tag: "litellm",
      ...age(litellm.asOf),
      stale: needsRefresh(litellm.asOf, now),
    } as const;
    return quote(litellm, source, `LiteLLM price data fetched ${litellm.asOf.toISOString()}`);
  }
  const source = { _tag: "snapshot", ...age(snapshot.asOf), commit: snapshot.commit } as const;
  return quote(snapshot, source, `bundled price snapshot of ${snapshot.asOf.toISOString()}`);
}
