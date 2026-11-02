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
import type { PriceSource } from "./prices";

export interface NativeImageModelsOptions {
  /** Prices every model before it is used. */
  prices: Pick<PriceSource, "lookup">;
  /** Where API keys are read from; defaults to the process environment. Keys are never stored. */
  env?: Record<string, string | undefined>;
  /** Replaces the network for Gemini calls (recorded-response tests). */
  geminiFetch?: GeminiFetch;
}

/**
 * The Image Models with native adapters (ADR-0004), selected by model id.
 * Getting one checks its API key and price first, so a missing key or an
 * unpriced model fails before any billable call. A new vendor is one more case.
 */
export const NativeImageModels = (options: NativeImageModelsOptions) => {
  const lookup = (model: string) =>
    options.prices
      .lookup(model)
      .pipe(
        Effect.catchTag("PriceStoreError", (error) =>
          Effect.fail(new ImageModelUnavailable({ model, message: errorMessage(error) })),
        ),
      );

  const gemini = (model: string, recorded: PriceQuote | undefined) =>
    Effect.gen(function* () {
      const apiKey = (options.env ?? process.env).GEMINI_API_KEY?.trim();
      if (!apiKey) {
        return yield* new ImageModelUnavailable({
          model,
          message: `GEMINI_API_KEY is not set; ${model} needs a Gemini API key in the environment`,
        });
      }
      // A header value can't hold control or non-ASCII characters; a runtime rejecting one
      // would quote the value in its error. Real keys are far longer than 20 characters, and a
      // very short one would make redaction garble every reason. Messages never echo the key.
      if (!/^[\x21-\x7e]{20,}$/.test(apiKey)) {
        return yield* new ImageModelUnavailable({
          model,
          message:
            "GEMINI_API_KEY is shorter than 20 characters or contains spaces, control or non-ASCII characters; check how it was set",
        });
      }
      const price = recorded ?? (yield* lookup(model));
      if (price.pricing._tag !== "GeminiImage") {
        return yield* new Unpriced({
          model,
          reason: `priced as ${price.pricing._tag}, not as a Gemini image model`,
        });
      }
      return geminiImageModel({
        model,
        apiKey,
        price: { ...price, pricing: price.pricing },
        ...(options.geminiFetch && { fetch: options.geminiFetch }),
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
        default:
          return Effect.fail(
            new ImageModelUnavailable({ model, message: `No Image Model adapter for ${model}` }),
          );
      }
    },
  });
};
