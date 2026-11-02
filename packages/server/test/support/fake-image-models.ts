import {
  type CallResult,
  type ImageModel,
  ImageModels,
  type ImageRequest,
  type PriceQuote,
  Unpriced,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { geminiCapabilities } from "@iconograph/adapters";
import { fixture as faceFixture } from "../../../adapters/test/face-models";

/** Licence-clear fixture portraits (see the adapters' fixtures README). */
export { faceFixture };

/** The Subject in the Run tests is Joe Biden; these are the Reference Photos. */
export const subjectPhotos = [faceFixture("biden-2022.jpg"), faceFixture("biden-2021.jpg")];

/**
 * What the fake returns per call, in call order: a fixture image of the Subject
 * (`same`), of someone else (`different`), with no face (`no-face`), bytes that
 * aren't an image (`garbage`), or a refusal, failure or transient error.
 */
export type FakeResponse =
  | "same"
  | "different"
  | "no-face"
  | "garbage"
  | "refuse"
  | "fail"
  | "transient";

const images: Record<"same" | "different" | "no-face", string> = {
  same: "biden-2013.jpg",
  different: "obama-2012.jpg",
  "no-face": "earth-apollo17.jpg",
};

export const FAKE_ESTIMATE_MICROS = 100_000;
export const FAKE_ACTUAL_MICROS = 80_000;

/** The fake price data: a Gemini image price, $0.10 per 2K image. */
export const FAKE_PRICE: PriceQuote = {
  model: "fake",
  pricing: {
    _tag: "GeminiImage",
    inputPerToken: 0,
    outputPerToken: 0,
    outputPerImageToken: 0,
    outputPerImage: 0,
    outputPer2KImage: 0.1,
  },
  source: { _tag: "override", asOf: "2026-11-01T00:00:00.000Z", ageSeconds: 0 },
};

export interface FakeImageModels {
  layer: Layer.Layer<ImageModels>;
  /** Every request the fake received, in call order. */
  requests: ImageRequest[];
}

export interface FakeOptions {
  /** Every model is `Unpriced`. */
  unpriced?: boolean;
  /** The cost a transient error reports: 0 (an unbilled HTTP error, the default) or null (unknown). */
  transientCost?: number | null;
  /** The MIME type image responses claim (default `image/jpeg`). */
  imageType?: string;
  /** Runs before each call answers, e.g. to break the image store. */
  beforeAnswer?: (call: number) => Promise<void>;
  /** Runs on each `ImageModels.get`, with the recorded price when one is given. */
  beforeGet?: (price: PriceQuote | undefined) => void;
}

/**
 * An Image Model that answers from a script, for Run-engine tests. Any model id
 * resolves to it, unless `unpriced` is set. It declares the real Gemini
 * adapter's capabilities, so the engine plans as it would in production.
 */
export function fakeImageModels(
  script: readonly FakeResponse[],
  options: FakeOptions = {},
): FakeImageModels {
  const requests: ImageRequest[] = [];
  const respond = async (response: FakeResponse | undefined): Promise<CallResult> => {
    const usage = { outputImageTokens: 1680 };
    switch (response) {
      case "same":
      case "different":
      case "no-face":
        return {
          kind: "image",
          image: {
            bytes: await Bun.file(faceFixture(images[response])).bytes(),
            mimeType: options.imageType ?? "image/jpeg",
          },
          usage,
          costMicros: FAKE_ACTUAL_MICROS,
        };
      case "garbage":
        return {
          kind: "image",
          image: { bytes: new TextEncoder().encode("not an image"), mimeType: "image/jpeg" },
          usage,
          costMicros: FAKE_ACTUAL_MICROS,
        };
      case "refuse":
        return {
          kind: "refused",
          reason: "safety: blocked by the fake",
          usage: null,
          costMicros: 0,
        };
      case "fail":
        return { kind: "failed", reason: "fake HTTP 400: bad request", usage: null, costMicros: 0 };
      case "transient":
        return {
          kind: "transient",
          reason: "fake HTTP 503",
          costMicros: options.transientCost === undefined ? 0 : options.transientCost,
        };
      case undefined:
        throw new Error(`The fake Image Model got call ${requests.length} beyond its script`);
    }
  };
  const model = (id: string, price: PriceQuote | undefined): ImageModel => ({
    model: id,
    capabilities: geminiCapabilities,
    price: price ?? { ...FAKE_PRICE, model: id },
    estimate: () => ({ micros: FAKE_ESTIMATE_MICROS, usage: { outputImageTokens: 1680 } }),
    call: (request) =>
      Effect.promise(async () => {
        const call = requests.push(request) - 1;
        await options.beforeAnswer?.(call);
        return respond(script[call]);
      }),
  });
  return {
    requests,
    layer: Layer.succeed(ImageModels)({
      get: (id, price) => {
        options.beforeGet?.(price);
        // As the real adapters: a recorded price must be for the requested model.
        if (price && price.model !== id) {
          return Effect.fail(
            new Unpriced({ model: id, reason: `the recorded price is for ${price.model}` }),
          );
        }
        return options.unpriced
          ? Effect.fail(new Unpriced({ model: id, reason: "not in the fake price data" }))
          : Effect.succeed(model(id, price));
      },
    }),
  };
}
