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
  llmPriceModel,
  type LlmVendor,
  type PriceQuote,
  Unpriced,
  type UnsuccessfulCall,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { MastraJudges } from "../../src/judge";
import { LLM_BASE_URLS } from "../../src/llm";
import { FAKE_PRICE, untilAborted } from "./fake-image-models";
import { fakeVendorFetch } from "./fake-vendors";

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

/** What `usage` costs at `price`, in micros; null when the price isn't an LLM's. */
export const fakeLlmCost = (
  price: PriceQuote,
  usage: { inputTokens: number; outputTokens: number },
) => (price.pricing._tag === "Llm" ? llmCostMicros(price.pricing, usage) : null);

/**
 * A fake role's unsuccessful answer, the same for every role: a failure (an
 * HTTP 400, at $0), a transient error at $0, or one of unknown cost.
 */
export const fakeUnsuccessful = (
  role: string,
  response: "fail" | "transient" | "transient-unknown-cost",
): UnsuccessfulCall => {
  switch (response) {
    case "fail":
      return {
        kind: "failed",
        reason: `fake ${role} HTTP 400: bad request`,
        usage: null,
        costMicros: 0,
      };
    case "transient":
      return { kind: "transient", reason: `fake ${role} HTTP 529: overloaded`, costMicros: 0 };
    case "transient-unknown-cost":
      return { kind: "transient", reason: "fake: connection reset", costMicros: null };
  }
};

/** An answer to one call, its usage priced at the Judge's price. */
const answer = (response: FakeJudgeResponse | undefined, price: PriceQuote): JudgeCallResult => {
  const usage = { inputTokens: 9_000, outputTokens: 400 };
  const costMicros = fakeLlmCost(price, usage);
  switch (response) {
    case "refuse":
      return { kind: "refused", reason: "fake: declined", usage, costMicros };
    case "fail":
    case "transient":
    case "transient-unknown-cost":
      return fakeUnsuccessful("Judge", response);
    case "unknown-cost":
      return { kind: "judged", verdict: FAKE_VERDICT, usage: null, costMicros: null };
    default:
      return { kind: "judged", verdict: response ?? FAKE_VERDICT, usage, costMicros };
  }
};

/**
 * A Judge that answers from a script, for Run-engine tests: any model id
 * resolves to it (priced as an LLM under `llmPriceModel`), unless `unpriced`.
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
      Effect.promise(async (signal) => {
        const call = requests.push(request) - 1;
        await untilAborted(signal, options.beforeAnswer?.(call));
        return answer(script[call], price);
      }),
  });
  return {
    requests,
    gets,
    layer: Layer.succeed(Judges)({
      checkCredentials: () => Effect.void,
      get: (config, recorded) => {
        gets.push({ judge: config, price: recorded });
        return fakeLlmGetPrice(config.model, recorded, options.unpriced, (model) =>
          fakeLlmPrice(model, options.lookupPricing?.(lookups++)),
        ).pipe(Effect.map((price) => judge(config, price)));
      },
    }),
  };
}

/** A fresh fake price lookup's quote for `model`: an LLM price (default `FAKE_JUDGE_PRICING`). */
export const fakeLlmPrice = (
  model: string,
  pricing: PriceQuote["pricing"] = FAKE_JUDGE_PRICING,
): PriceQuote => ({ model, pricing, source: FAKE_PRICE.source });

/**
 * A fake role's price as the real roles resolve it: `Unpriced` when
 * `unpriced`, or when the recorded price is another model's; else the
 * recorded price, or `fresh` for the model it is priced under.
 */
export const fakeLlmGetPrice = (
  configModel: string,
  recorded: PriceQuote | undefined,
  unpriced: boolean | undefined,
  fresh: (model: string) => PriceQuote,
): Effect.Effect<PriceQuote, Unpriced> => {
  const model = llmPriceModel(configModel);
  if (unpriced) return Effect.fail(new Unpriced({ model, reason: "not in the fake price data" }));
  if (recorded && recorded.model !== model) {
    return Effect.fail(
      new Unpriced({ model, reason: `the recorded price is for ${recorded.model}` }),
    );
  }
  return Effect.succeed(recorded ?? fresh(model));
};

/**
 * The real Judges, priced at `FAKE_JUDGE_PRICING`, on the fake `vendor` API
 * (Anthropic unless given) at `origin`.
 */
export const judgesOnFakeVendor = (origin: string, vendor: LlmVendor = "anthropic") =>
  judgesOnFakeVendors({ [vendor]: origin });

/**
 * The real Judges, priced at `FAKE_JUDGE_PRICING`, each vendor's calls on its
 * fake API at `origins[vendor]`; any other request is refused before it
 * leaves. Keys are read from `env` (default: the process environment).
 */
export function judgesOnFakeVendors(
  origins: { readonly [V in LlmVendor]?: string },
  env?: Record<string, string | undefined>,
) {
  const routes = (Object.keys(origins) as LlmVendor[]).map((vendor) => ({
    origin: new URL(LLM_BASE_URLS[vendor]).origin,
    fetch: fakeVendorFetch(origins[vendor]!, "Judge", vendor),
  }));
  return MastraJudges({
    prices: { lookup: (model) => Effect.succeed(fakeLlmPrice(model)) },
    ...(env && { env }),
    fetch: (input, init) => {
      const origin = new URL(String(input)).origin;
      return (routes.find((route) => route.origin === origin) ?? routes[0]!).fetch(input, init);
    },
  });
}

/**
 * The Judges of the test entry points: the real Judges on the fake Anthropic
 * API at FAKE_ANTHROPIC_ORIGIN when it is set, else the fake Judge answering
 * from `script`.
 */
export const fakeJudgesFromEnv = (script: readonly FakeJudgeResponse[] = []) => {
  const origin = process.env.FAKE_ANTHROPIC_ORIGIN;
  return origin ? judgesOnFakeVendor(origin) : fakeJudges(script).layer;
};
