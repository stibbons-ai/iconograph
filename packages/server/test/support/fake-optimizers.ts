import {
  type LlmVendor,
  type OptimizerCallResult,
  type OptimizerConfig,
  type OptimizerRequest,
  Optimizers,
  type PriceQuote,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { MastraOptimizers } from "../../src/optimizer";
import { untilAborted } from "./fake-image-models";
import { fakeLlmCost, fakeLlmGetPrice, fakeLlmPrice, fakeUnsuccessful } from "./fake-judges";
import { fakeVendorFetch } from "./fake-vendors";

export const FAKE_OPTIMIZER_ESTIMATE_MICROS = 20_000;
/** What a call that answers costs: its usage report at `FAKE_JUDGE_PRICING`. */
export const FAKE_OPTIMIZER_ACTUAL_MICROS = 3_000;
const usage = { inputTokens: 4_000, outputTokens: 800 };

/**
 * What the fake Optimizer answers per call, in call order: a Prompt (any
 * other text), a refusal, a failure, or a transient error ($0, or of unknown
 * cost); past the script it writes `Prompt <n>` (its call number from 1).
 */
export type FakeOptimizerResponse =
  | string
  | { readonly refuse: string }
  | "fail"
  | "transient"
  | "transient-unknown-cost";

export interface FakeOptimizers {
  layer: Layer.Layer<Optimizers>;
  /** Every request the fake Optimizer received, in call order. */
  requests: OptimizerRequest[];
}

export interface FakeOptimizerOptions {
  /** Every Optimizer is `Unpriced`. */
  unpriced?: boolean;
  /** The estimate of every call (default `FAKE_OPTIMIZER_ESTIMATE_MICROS`). */
  estimateMicros?: number;
  /** Runs before each call answers. */
  beforeAnswer?: (call: number) => Promise<void>;
}

const answer = (
  response: FakeOptimizerResponse | undefined,
  call: number,
  price: PriceQuote,
): OptimizerCallResult => {
  const costMicros = fakeLlmCost(price, usage);
  if (response === undefined) {
    return { kind: "optimized", prompt: `Prompt ${call + 1}`, usage, costMicros };
  }
  if (typeof response === "object") {
    return { kind: "refused", reason: response.refuse, usage, costMicros };
  }
  switch (response) {
    case "fail":
    case "transient":
    case "transient-unknown-cost":
      return fakeUnsuccessful("Optimizer", response);
    default:
      return { kind: "optimized", prompt: response, usage, costMicros };
  }
};

/**
 * An Optimizer that answers from a script, for Run-engine tests: any model id
 * resolves to it (priced as an LLM under `llmPriceModel`), unless `unpriced`.
 */
export function fakeOptimizers(
  script: readonly FakeOptimizerResponse[] = [],
  options: FakeOptimizerOptions = {},
): FakeOptimizers {
  const requests: OptimizerRequest[] = [];
  const optimizer = (config: OptimizerConfig, price: PriceQuote) => ({
    model: config.model,
    effort: config.effort,
    price,
    estimate: () => ({
      micros: options.estimateMicros ?? FAKE_OPTIMIZER_ESTIMATE_MICROS,
      usage: { inputTokens: 10_000 },
    }),
    call: (request: OptimizerRequest) =>
      Effect.promise(async (signal) => {
        const call = requests.push(request) - 1;
        await untilAborted(signal, options.beforeAnswer?.(call));
        return answer(script[call], call, price);
      }),
  });
  return {
    requests,
    layer: Layer.succeed(Optimizers)({
      checkCredentials: () => Effect.void,
      get: (config, recorded) =>
        fakeLlmGetPrice(config.model, recorded, options.unpriced, (model) =>
          fakeLlmPrice(model),
        ).pipe(Effect.map((price) => optimizer(config, price))),
    }),
  };
}

/**
 * The real Optimizers, priced at `FAKE_JUDGE_PRICING`, on the fake `vendor`
 * API (Anthropic unless given) at `origin`.
 */
export const optimizersOnFakeVendor = (origin: string, vendor: LlmVendor = "anthropic") =>
  MastraOptimizers({
    prices: { lookup: (model) => Effect.succeed(fakeLlmPrice(model)) },
    fetch: fakeVendorFetch(origin, "Optimizer", vendor),
  });

/**
 * The Optimizers of the test entry points: the real Optimizers on the fake
 * Anthropic API at FAKE_ANTHROPIC_ORIGIN when it is set, else the fake
 * Optimizer answering from `script`.
 */
export const fakeOptimizersFromEnv = (script: readonly FakeOptimizerResponse[] = []) => {
  const origin = process.env.FAKE_ANTHROPIC_ORIGIN;
  return origin ? optimizersOnFakeVendor(origin) : fakeOptimizers(script).layer;
};
