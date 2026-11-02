import {
  ImageModels,
  ImageModelUnavailable,
  type PriceQuote,
  pricingSpec,
  Unpriced,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { errorMessage } from "./errors";
import { type GeminiFetch, geminiImageModel } from "./gemini";
import { type OpenAIFetch, openaiImageModel } from "./openai";
import type { PriceSource } from "./prices";

export interface NativeImageModelsOptions {
  /** Prices every model before it is used. */
  prices: Pick<PriceSource, "lookup">;
  /** Where API keys are read from; defaults to the process environment. Keys are never stored. */
  env?: Record<string, string | undefined>;
  /** Replaces the network for Gemini calls (recorded-response tests). */
  geminiFetch?: GeminiFetch;
  /** Replaces the network for OpenAI calls (recorded-response tests). */
  openaiFetch?: OpenAIFetch;
}

/**
 * The API key in `variable` of `env`, checked before any price lookup or
 * billable call. A header value can't hold control or non-ASCII characters; a
 * runtime rejecting one would quote the value in its error. Real keys are far
 * longer than 20 characters, and a very short one would make redaction garble
 * every reason. Messages never echo the key.
 */
const apiKey = (env: Record<string, string | undefined>, variable: string, model: string) =>
  Effect.gen(function* () {
    const key = env[variable]?.trim();
    if (!key) {
      return yield* new ImageModelUnavailable({
        model,
        message: `${variable} is not set; ${model} needs its API key in the environment`,
      });
    }
    if (!/^[\x21-\x7e]{20,}$/.test(key)) {
      return yield* new ImageModelUnavailable({
        model,
        message: `${variable} is shorter than 20 characters or contains spaces, control or non-ASCII characters; check how it was set`,
      });
    }
    return key;
  });

/**
 * The Image Models with native adapters (ADR-0004), selected by model id.
 * Getting one checks its API key and price first, so a missing key or an
 * unpriced model fails before any billable call. A new vendor is one more case.
 */
export const NativeImageModels = (options: NativeImageModelsOptions) => {
  const env = options.env ?? process.env;
  const lookup = (model: string, recorded: PriceQuote | undefined) =>
    recorded
      ? Effect.succeed(recorded)
      : options.prices
          .lookup(model)
          .pipe(
            Effect.catchTag("PriceStoreError", (error) =>
              Effect.fail(new ImageModelUnavailable({ model, message: errorMessage(error) })),
            ),
          );
  const mispriced = (model: string, price: PriceQuote, mode: string) =>
    new Unpriced({ model, reason: `priced as ${price.pricing._tag}, not as ${mode}` });

  const gemini = (model: string, recorded: PriceQuote | undefined) =>
    Effect.gen(function* () {
      const key = yield* apiKey(env, "GEMINI_API_KEY", model);
      const price = yield* lookup(model, recorded);
      if (price.pricing._tag !== "GeminiImage") {
        return yield* mispriced(model, price, "a Gemini image model");
      }
      return geminiImageModel({
        model,
        apiKey: key,
        price: { ...price, pricing: price.pricing },
        ...(options.geminiFetch && { fetch: options.geminiFetch }),
      });
    });

  const openai = (model: string, recorded: PriceQuote | undefined) =>
    Effect.gen(function* () {
      const key = yield* apiKey(env, "OPENAI_API_KEY", model);
      const price = yield* lookup(model, recorded);
      if (price.pricing._tag !== "OpenAIImage") {
        return yield* mispriced(model, price, "an OpenAI image model");
      }
      return openaiImageModel({
        model,
        apiKey: key,
        price: { ...price, pricing: price.pricing },
        ...(options.openaiFetch && { fetch: options.openaiFetch }),
      });
    });

  return Layer.succeed(ImageModels)({
    get: (model, price) => {
      if (price && price.model !== model) {
        return Effect.fail(
          new Unpriced({ model, reason: `the recorded price is for ${price.model}` }),
        );
      }
      switch (pricingSpec(model).mode) {
        case "GeminiImage":
          return gemini(model, price);
        case "OpenAIImage":
          return openai(model, price);
        default:
          return Effect.fail(
            new ImageModelUnavailable({ model, message: `No Image Model adapter for ${model}` }),
          );
      }
    },
  });
};
