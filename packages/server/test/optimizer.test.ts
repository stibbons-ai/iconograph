import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TARGET_LOOK,
  type Effort,
  llmCostMicros,
  llmVendor,
  MAX_OUTPUT_TOKENS,
  type Optimizer,
  type OptimizerRequest,
  Optimizers,
  type PriceQuote,
} from "@iconograph/domain";
import { Effect, type Layer } from "effect";
import { withEnvironment } from "../../adapters/test/git-environment";
import type { LlmAgentsOptions } from "../src/llm";
import { MastraOptimizers } from "../src/optimizer";
import { FAKE_VERDICT } from "./support/fake-judges";
import { vendorAnswer } from "./support/fake-vendors";

const KEY = "SENTINEL-OPTIMIZER-KEY-0123456789";
const allKeys = {
  ICONOGRAPH_ANTHROPIC_API_KEY: KEY,
  ICONOGRAPH_OPENAI_API_KEY: KEY,
  ICONOGRAPH_GEMINI_API_KEY: KEY,
};
const sonnetPricing = { _tag: "Llm", inputPerToken: 2e-6, outputPerToken: 1e-5 } as const;
const sonnetPrice: PriceQuote = {
  model: "claude-sonnet-5-5",
  pricing: sonnetPricing,
  source: { _tag: "override", asOf: "2026-11-01T00:00:00.000Z", ageSeconds: 0 },
};
/** 9,000 input and 300 output tokens (every fake vendor answer) at $2/M and $10/M. */
const ANSWER_COST_MICROS = 21_000;

const request: OptimizerRequest = {
  targetLook: DEFAULT_TARGET_LOOK,
  history: [
    {
      iteration: 1,
      prompt: "A studio headshot of the person in the reference photos.",
      candidates: [
        { candidate: 0, outcome: { _tag: "Refused", reason: "safety: blocked" }, judgement: null },
      ],
    },
  ],
};

/** The real provider-built Optimizers, their network replaced by `network`. */
const providerOptimizers = (
  network: NonNullable<LlmAgentsOptions["fetch"]>,
  options: Partial<LlmAgentsOptions> = {},
) =>
  MastraOptimizers({
    env: allKeys,
    prices: { lookup: (priced) => Effect.succeed({ ...sonnetPrice, model: priced }) },
    fetch: network,
    ...options,
  });

const getOptimizer = (
  layer: Layer.Layer<Optimizers>,
  model = "anthropic/claude-sonnet-5-5",
  effort: Effort = "medium",
  recorded?: PriceQuote,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Optimizers).get({ model, effort }, recorded);
    }).pipe(Effect.provide(layer)),
  );

const call = (optimizer: Optimizer) => Effect.runPromise(optimizer.call(request));

/** Optimizers whose vendor answers every call with `text`. */
const answering = (model: string, text: string, cutOff = false) =>
  providerOptimizers(async () => vendorAnswer(llmVendor(model)!, text, cutOff));

describe("Mastra Optimizer", () => {
  test.each([
    [
      "anthropic/claude-sonnet-5-5",
      "medium",
      "https://api.anthropic.com/v1/messages",
      ["x-api-key", KEY],
      { model: "claude-sonnet-5-5", output_config: { effort: "medium" } },
    ],
    [
      "openai/gpt-5.5",
      "high",
      "https://api.openai.com/v1/responses",
      ["authorization", `Bearer ${KEY}`],
      { model: "gpt-5.5", reasoning: { effort: "high" } },
    ],
    [
      "google/gemini-3.1-pro-preview",
      "low",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
      ["x-goog-api-key", KEY],
      { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } },
    ],
  ] as const)(
    "%s at %s effort sends its key, the history and its effort only to its vendor's API, and decodes the Prompt with its cost",
    async (model, effort, url, [header, auth], reasoning) => {
      const sent: { url: string; init: BunFetchRequestInit }[] = [];
      const layer = providerOptimizers(async (input, init) => {
        sent.push({ url: String(input), init });
        return vendorAnswer(llmVendor(model)!, JSON.stringify({ prompt: "  A better Prompt.\n" }));
      });
      const result = await withEnvironment(
        {
          ANTHROPIC_BASE_URL: "https://proxy.example/v1",
          OPENAI_BASE_URL: "https://proxy.example/v1",
        },
        async () => call(await getOptimizer(layer, model, effort)),
      );
      expect(result).toEqual({
        kind: "optimized",
        prompt: "A better Prompt.",
        usage: expect.objectContaining({ inputTokens: 9_000, outputTokens: 300 }),
        costMicros: ANSWER_COST_MICROS,
      });
      expect(sent.map((request) => request.url)).toEqual([url]);
      const { init } = sent[0]!;
      expect(new Headers(init.headers).get(header)).toBe(auth);
      expect(init.timeout).toBe(false);
      const body = String(init.body);
      expect(JSON.parse(body)).toMatchObject(reasoning);
      // The Lane's history and the Target Look go out as text.
      expect(body).toContain("safety: blocked");
      expect(body).toContain(DEFAULT_TARGET_LOOK.clothing);
    },
  );

  test.each([
    [
      "an answer that isn't JSON",
      "Here is a better Prompt: smile",
      "doesn't match its output schema",
    ],
    ["JSON without a Prompt", JSON.stringify(FAKE_VERDICT), "doesn't match its output schema"],
    ["a blank Prompt", JSON.stringify({ prompt: "  " }), "The Optimizer's Prompt is blank"],
    [
      "a Prompt over 32,000 characters",
      JSON.stringify({ prompt: "x".repeat(32_001) }),
      "The Optimizer's Prompt has 32001 characters, over the limit of 32000",
    ],
  ])("%s fails the call at its cost, with the reason", async (_, text, reason) => {
    const model = "anthropic/claude-sonnet-5-5";
    expect(await call(await getOptimizer(answering(model, text), model))).toEqual({
      kind: "failed",
      reason: expect.stringContaining(reason),
      usage: expect.objectContaining({ inputTokens: 9_000 }),
      costMicros: ANSWER_COST_MICROS,
    });
  });

  test("an answer cut off at the output cap fails the call at its cost", async () => {
    const model = "openai/gpt-5.5";
    const optimizer = await getOptimizer(answering(model, '{"prompt": "A be', true), model);
    expect(await call(optimizer)).toMatchObject({
      kind: "failed",
      costMicros: ANSWER_COST_MICROS,
      reason: `The Optimizer hit its ${MAX_OUTPUT_TOKENS.medium}-token output cap, reasoning included, before finishing its answer`,
    });
  });

  test("its estimate prices the whole output cap at the Optimizer's LLM price", async () => {
    const optimizer = await getOptimizer(answering("anthropic/claude-sonnet-5-5", "{}"));
    const { micros, usage } = optimizer.estimate(request);
    expect(usage.outputTokens).toBe(MAX_OUTPUT_TOKENS.medium);
    expect(micros).toBe(
      llmCostMicros(sonnetPricing, {
        inputTokens: usage.inputTokens!,
        outputTokens: usage.outputTokens!,
      }),
    );
  });

  test("a missing key or an unknown vendor fails before any price lookup", async () => {
    const lookups: string[] = [];
    const layer = MastraOptimizers({
      env: {},
      prices: {
        lookup: (model) =>
          Effect.sync(() => {
            lookups.push(model);
            return { ...sonnetPrice, model };
          }),
      },
    });
    const failure = (model: string) =>
      getOptimizer(layer, model).then(
        () => "got an Optimizer",
        (error: unknown) => String(error),
      );
    expect(await failure("anthropic/claude-sonnet-5-5")).toContain(
      "ICONOGRAPH_ANTHROPIC_API_KEY is not set",
    );
    expect(await failure("xai/grok-5")).toContain(
      'No Optimizer for "xai/grok-5"; the Optimizer is an anthropic/, openai/ or google/ model',
    );
    expect(lookups).toEqual([]);
  });

  test("a recorded price is used instead of a lookup, and must be the Optimizer's", async () => {
    const lookups: string[] = [];
    const layer = MastraOptimizers({
      env: allKeys,
      prices: {
        lookup: (model) =>
          Effect.sync(() => {
            lookups.push(model);
            return { ...sonnetPrice, model };
          }),
      },
    });
    const recorded = { ...sonnetPrice, pricing: { ...sonnetPrice.pricing, inputPerToken: 1e-6 } };
    const optimizer = await getOptimizer(layer, undefined, undefined, recorded);
    expect(optimizer.price).toEqual(recorded);
    expect(lookups).toEqual([]);
    await expect(getOptimizer(layer, "openai/gpt-5.5", undefined, recorded)).rejects.toThrow(
      "the recorded price is for claude-sonnet-5-5",
    );
  });
});
