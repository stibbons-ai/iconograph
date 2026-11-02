import { fileURLToPath } from "node:url";
import type { GeminiImagePricing, PriceQuote } from "@iconograph/domain";

/** Gemini image prices for tests (the snapshot's rates when the fixtures were written). */
export const geminiTestPrice: PriceQuote & { pricing: GeminiImagePricing } = {
  model: "gemini-nano-banana-2.1",
  pricing: {
    _tag: "GeminiImage",
    inputPerToken: 1.5e-6,
    outputPerToken: 7.5e-6,
    outputPerImageToken: 3e-5,
    outputPerImage: 0.0336,
    outputPer2KImage: 0.0504,
  },
  source: { _tag: "snapshot", asOf: "2026-11-01T00:00:00.000Z", ageSeconds: 0, commit: "test" },
};

/** A recorded Gemini response body from `fixtures/gemini`. */
export const recordedGemini = (name: string) =>
  Bun.file(fileURLToPath(new URL(`./fixtures/gemini/${name}`, import.meta.url))).text();
