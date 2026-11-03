import {
  byCriterion,
  CURRENT_RUBRIC,
  JUDGED_CRITERIA,
  llmCostMicros,
  type Judge,
  type JudgeCallResult,
  type JudgeConfig,
  type JudgeRequest,
  Judges,
  type JudgeVerdict,
  judgePriceModel,
  type PriceQuote,
  Unpriced,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { JUDGE_BASE_URLS, MastraJudges } from "../../src/judge";
import { FAKE_PRICE } from "./fake-image-models";

export const FAKE_JUDGE_ESTIMATE_MICROS = 10_000;
export const FAKE_JUDGE_ACTUAL_MICROS = 5_000;

/** Every criterion at `level`. */
export const levels = (level: 1 | 2 | 3 | 4 | 5): JudgeVerdict["levels"] =>
  byCriterion(JUDGED_CRITERIA, () => level);

/** The verdict the fake gives unless its script says otherwise: every criterion at level 4. */
export const FAKE_VERDICT: JudgeVerdict = {
  levels: levels(4),
  issues: ["The collar is asymmetric"],
  promptFixes: ["Make the shirt collar symmetric"],
};

/**
 * What the fake Judge answers per call, in call order: a verdict, a refusal,
 * a failure, a transient error ($0, or of unknown cost), or `FAKE_VERDICT`
 * without a usage report (`unknown-cost`); past the script it gives
 * `FAKE_VERDICT`.
 */
export type FakeJudgeResponse =
  | JudgeVerdict
  | "refuse"
  | "fail"
  | "transient"
  | "transient-unknown-cost"
  | "unknown-cost";

/** The fake's LLM price, at which its usage report costs `FAKE_JUDGE_ACTUAL_MICROS`. */
export const FAKE_JUDGE_PRICING = {
  _tag: "Llm",
  inputPerToken: 5e-7,
  outputPerToken: 1.25e-6,
} as const;

export interface FakeJudges {
  layer: Layer.Layer<Judges>;
  /** Every request the fake Judge received, in call order. */
  requests: JudgeRequest[];
  /** Every Judge the engine got, with the recorded price when one was given. */
  gets: { judge: Pick<JudgeConfig, "model" | "effort">; price: PriceQuote | undefined }[];
}

export interface FakeJudgeOptions {
  /** Every Judge is `Unpriced`. */
  unpriced?: boolean;
  /** The estimate of every call (default `FAKE_JUDGE_ESTIMATE_MICROS`). */
  estimateMicros?: number;
  /** Runs before each call answers. */
  beforeAnswer?: (call: number) => Promise<void>;
  /** The pricing a fresh price lookup returns, by lookup (from 0); default `FAKE_JUDGE_PRICING`. */
  lookupPricing?: (lookup: number) => PriceQuote["pricing"];
}

/** An answer to one call, its usage priced at the Judge's price. */
const answer = (response: FakeJudgeResponse | undefined, price: PriceQuote): JudgeCallResult => {
  const usage = { inputTokens: 9_000, outputTokens: 400 };
  const costMicros = price.pricing._tag === "Llm" ? llmCostMicros(price.pricing, usage) : null;
  switch (response) {
    case "refuse":
      return { kind: "refused", reason: "fake: declined", usage, costMicros };
    case "fail":
      return {
        kind: "failed",
        reason: "fake Judge HTTP 400: bad request",
        usage: null,
        costMicros: 0,
      };
    case "transient":
      return { kind: "transient", reason: "fake Judge HTTP 529: overloaded", costMicros: 0 };
    case "transient-unknown-cost":
      return { kind: "transient", reason: "fake: connection reset", costMicros: null };
    case "unknown-cost":
      return { kind: "judged", verdict: FAKE_VERDICT, usage: null, costMicros: null };
    default:
      return { kind: "judged", verdict: response ?? FAKE_VERDICT, usage, costMicros };
  }
};

/**
 * A Judge that answers from a script, for Run-engine tests: any model id
 * resolves to it (priced as an LLM under `judgePriceModel`), unless `unpriced`.
 */
export function fakeJudges(
  script: readonly FakeJudgeResponse[] = [],
  options: FakeJudgeOptions = {},
): FakeJudges {
  const requests: JudgeRequest[] = [];
  const gets: FakeJudges["gets"] = [];
  let lookups = 0;
  const judge = (config: Pick<JudgeConfig, "model" | "effort">, price: PriceQuote): Judge => ({
    model: config.model,
    effort: config.effort,
    price,
    rubric: CURRENT_RUBRIC,
    estimate: () => ({
      micros: options.estimateMicros ?? FAKE_JUDGE_ESTIMATE_MICROS,
      usage: { inputTokens: 10_000 },
    }),
    call: (request) =>
      Effect.promise(async () => {
        const call = requests.push(request) - 1;
        await options.beforeAnswer?.(call);
        return answer(script[call], price);
      }),
  });
  return {
    requests,
    gets,
    layer: Layer.succeed(Judges)({
      get: (config, recorded) => {
        gets.push({ judge: config, price: recorded });
        const model = judgePriceModel(config.model);
        if (options.unpriced) {
          return Effect.fail(new Unpriced({ model, reason: "not in the fake price data" }));
        }
        if (recorded && recorded.model !== model) {
          return Effect.fail(
            new Unpriced({ model, reason: `the recorded price is for ${recorded.model}` }),
          );
        }
        return Effect.succeed(
          judge(config, recorded ?? fakeJudgePrice(model, options.lookupPricing?.(lookups++))),
        );
      },
    }),
  };
}

/** A fresh fake price lookup's quote for `model`. */
const fakeJudgePrice = (
  model: string,
  pricing: PriceQuote["pricing"] = FAKE_JUDGE_PRICING,
): PriceQuote => ({ model, pricing, source: FAKE_PRICE.source });

/**
 * The real Judges, priced at `FAKE_JUDGE_PRICING`, with their calls to the
 * Anthropic API sent to the fake one at `origin`. A request to a loopback
 * address goes there unchanged, so a local trap sees a misrouted call; any
 * other request is refused before it leaves, so no test reaches a live vendor.
 */
export const judgesOnFakeAnthropic = (origin: string) => {
  const anthropic = new URL(JUDGE_BASE_URLS.anthropic).origin;
  return MastraJudges({
    prices: { lookup: (model) => Effect.succeed(fakeJudgePrice(model)) },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === anthropic) return fetch(`${origin}${url.pathname}${url.search}`, init);
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fetch(url, init);
      // ERR_INVALID_URL: classified as failed at $0 and not retried, like a local refusal.
      throw Object.assign(
        new TypeError(`The fake Anthropic Judge refused a request to ${url.origin}`),
        { code: "ERR_INVALID_URL" },
      );
    },
  });
};

/**
 * The Judges of the test entry points: the real Judges on the fake Anthropic
 * API at FAKE_ANTHROPIC_ORIGIN when it is set, else the fake Judge answering
 * from `script`.
 */
export const fakeJudgesFromEnv = (script: readonly FakeJudgeResponse[] = []) => {
  const origin = process.env.FAKE_ANTHROPIC_ORIGIN;
  return origin ? judgesOnFakeAnthropic(origin) : fakeJudges(script).layer;
};
