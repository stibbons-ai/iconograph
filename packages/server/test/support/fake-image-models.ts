import {
  type CallResult,
  type ImageModel,
  ImageModels,
  type ImageRequest,
  type PriceQuote,
  pricingSpec,
  Unpriced,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { geminiCapabilities, openaiCapabilities } from "@iconograph/adapters";
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

/** The fake price of an OpenAI Image Model: free tokens, billed as an OpenAI image model. */
export const FAKE_OPENAI_PRICE: PriceQuote = {
  model: "fake",
  pricing: { _tag: "OpenAIImage", inputPerToken: 0, inputPerImageToken: 0, outputPerImageToken: 0 },
  source: FAKE_PRICE.source,
};

/** A request the fake received, with the model it was sent to. */
export interface FakeRequest extends ImageRequest {
  readonly model: string;
}

export interface FakeImageModels {
  layer: Layer.Layer<ImageModels>;
  /** Every request the fake received, in call order, across models. */
  requests: FakeRequest[];
}

/** One script for all calls, or one per model id, each answered in that model's call order. */
export type FakeScript =
  | readonly FakeResponse[]
  | Readonly<Record<string, readonly FakeResponse[]>>;

export interface FakeOptions {
  /** Every model is `Unpriced`. */
  unpriced?: boolean;
  /** The cost a transient error reports: 0 (an unbilled HTTP error, the default) or null (unknown). */
  transientCost?: number | null;
  /** The file a `same` response returns instead of the fixture, e.g. a larger image. */
  sameImage?: string;
  /** The MIME type image responses claim (default `image/jpeg`). */
  imageType?: string;
  /** Runs before each call answers, with its index in `requests` and its model. */
  beforeAnswer?: (call: number, model: string) => Promise<void>;
  /** Runs on each `ImageModels.get`, with the recorded price when one is given. */
  beforeGet?: (price: PriceQuote | undefined) => void;
  /** What a face image (`same`, `different`, `no-face`) costs; `garbage` keeps `FAKE_ACTUAL_MICROS`. */
  actualMicros?: number;
  /**
   * The price of a model given no recorded one, e.g. for a model id no longer
   * in the price table; undefined (or no option) falls back by the price
   * table's mode: `FAKE_OPENAI_PRICE` for an id it maps as `OpenAIImage`,
   * `FAKE_PRICE` (GeminiImage, with Gemini capabilities) for any other,
   * including an OpenAI id no longer in the table.
   */
  price?: (id: string) => PriceQuote | undefined;
  /** Each call's estimate (default `FAKE_ESTIMATE_MICROS`). */
  estimateMicros?: (request: ImageRequest) => number;
}

/**
 * An Image Model that answers from a script, for Run-engine tests. Any model id
 * resolves to it, unless `unpriced` is set; production would reject an id no
 * longer in the price table, which resolves here only so a test can build a
 * Run stored with an old id. It declares the real adapters' capabilities by
 * its price (OpenAI's for an OpenAI image price, Gemini's for any other), so
 * the engine plans as it would in production.
 */
export function fakeImageModels(script: FakeScript, options: FakeOptions = {}): FakeImageModels {
  const requests: FakeRequest[] = [];
  /** The scripted response to a model's call, by its index overall and for that model. */
  const scripted = (id: string, call: number) => {
    if (Array.isArray(script)) return (script as readonly FakeResponse[])[call];
    const own = requests.filter(({ model }) => model === id).length - 1;
    return (script as Readonly<Record<string, readonly FakeResponse[]>>)[id]?.[own];
  };
  const respond = async (response: FakeResponse | undefined): Promise<CallResult> => {
    const usage = { outputImageTokens: 1680 };
    switch (response) {
      case "same":
      case "different":
      case "no-face":
        return {
          kind: "image",
          image: {
            bytes: await Bun.file(
              response === "same" && options.sameImage
                ? options.sameImage
                : faceFixture(images[response]),
            ).bytes(),
            mimeType: options.imageType ?? "image/jpeg",
          },
          usage,
          costMicros: options.actualMicros ?? FAKE_ACTUAL_MICROS,
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
  const model = (id: string, recorded: PriceQuote | undefined): ImageModel => {
    const price = recorded ??
      options.price?.(id) ?? {
        ...(pricingSpec(id).mode === "OpenAIImage" ? FAKE_OPENAI_PRICE : FAKE_PRICE),
        model: id,
      };
    return {
      model: id,
      capabilities: price.pricing._tag === "OpenAIImage" ? openaiCapabilities : geminiCapabilities,
      price,
      estimate: (request) => ({
        micros: options.estimateMicros?.(request) ?? FAKE_ESTIMATE_MICROS,
        usage: { outputImageTokens: 1680 },
      }),
      call: (request) =>
        Effect.promise(async (signal) => {
          const call = requests.push({ ...request, model: id }) - 1;
          // Picked at once: other calls may arrive while `beforeAnswer` waits.
          const response = scripted(id, call);
          await untilAborted(signal, options.beforeAnswer?.(call, id));
          return respond(response);
        }),
    };
  };
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

/**
 * Waits for `held` (a fake's `beforeAnswer`), as a vendor request does: it
 * ends early, rejecting, when the call is interrupted (`signal` aborts).
 */
export async function untilAborted(signal: AbortSignal, held: Promise<void> | undefined) {
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  await Promise.race([held, aborted]);
}
