import { fileURLToPath } from "node:url";
import type { OpenAIImagePricing, PriceQuote } from "@iconograph/domain";

/** OpenAI image prices for tests (the snapshot's GPT Image 2.6 rates). */
export const openaiTestPrice: PriceQuote & { pricing: OpenAIImagePricing } = {
  model: "gpt-image-2.6-sunburst",
  pricing: {
    _tag: "OpenAIImage",
    inputPerToken: 5e-6,
    inputPerImageToken: 8e-6,
    outputPerImageToken: 3e-5,
  },
  source: { _tag: "snapshot", asOf: "2026-11-02T00:00:00.000Z", ageSeconds: 0, commit: "test" },
};

/** A recorded OpenAI response body from `fixtures/openai`. */
export const recordedOpenAI = (name: string) =>
  Bun.file(fileURLToPath(new URL(`./fixtures/openai/${name}`, import.meta.url))).text();
