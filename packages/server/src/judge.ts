import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  apiKeyFromEnv,
  codeOf,
  errorMessage,
  hasErrorNamed,
  httpErrorResult,
  type PriceSource,
  redactKey,
  statusOf,
  toMastraSchema,
} from "@iconograph/adapters";
import {
  CURRENT_RUBRIC,
  judgeTimeoutMs,
  judgeImageTokens,
  type JudgeVendor,
  estimateJudgeCall,
  type JudgeCallResult,
  type JudgeEffort,
  judgeInstructions,
  judgeMessage,
  judgePriceModel,
  type JudgeRequest,
  type LlmPricing,
  Judges,
  JudgeUnavailable,
  JudgeVerdict,
  parseJudgeModel,
  JUDGE_MAX_OUTPUT_TOKENS,
  llmCostMicros,
  Unpriced,
  type Usage,
} from "@iconograph/domain";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { noopLogger } from "@mastra/core/logger";
import { Effect, Layer, Schema } from "effect";

/** The environment variables holding each Judge vendor's key. */
const judgeKeys: { readonly [V in JudgeVendor]: readonly [string, ...string[]] } = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
};

/**
 * Each vendor's API endpoint: the provider packages' own defaults, set
 * explicitly so `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`, which those
 * packages read when none is given, can't send the key and the Reference
 * Photos elsewhere.
 */
export const JUDGE_BASE_URLS: { readonly [V in JudgeVendor]: string } = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

/** `fetch` without Bun's `preconnect`: the network a Judge's provider sends through. */
type JudgeFetch = (input: string | URL | Request, init: BunFetchRequestInit) => Promise<Response>;

/**
 * The Judge's language model from its vendor's AI SDK provider, called the
 * way Mastra's model router calls it (OpenAI through the Responses API).
 * Calls are non-streaming, so no bytes arrive until the answer is done: each
 * request turns off Bun's fetch idle timeout (300 s by default), leaving the
 * per-effort abort as the only deadline.
 */
function judgeLanguageModel(
  vendor: JudgeVendor,
  modelId: string,
  apiKey: string,
  network: JudgeFetch,
): MastraModelConfig {
  const settings = {
    apiKey,
    baseURL: JUDGE_BASE_URLS[vendor],
    fetch: Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        network(input, { ...init, timeout: false }),
      { preconnect: fetch.preconnect },
    ),
  };
  switch (vendor) {
    case "anthropic":
      return createAnthropic(settings).languageModel(modelId);
    case "openai":
      return createOpenAI(settings).responses(modelId);
    case "google":
      return createGoogleGenerativeAI(settings).chat(modelId);
  }
}

/**
 * The provider options setting a role's effort through each vendor's reasoning
 * parameter (checked against the pinned AI SDK providers): Anthropic `effort`,
 * OpenAI `reasoningEffort`, Gemini `thinkingConfig.thinkingLevel`.
 */
function reasoningOptions(vendor: JudgeVendor, effort: JudgeEffort) {
  switch (vendor) {
    case "anthropic":
      return { anthropic: { effort } };
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
  }
}

export interface MastraJudgesOptions {
  /** Prices every Judge before it is used, under `judgePriceModel`. */
  prices: Pick<PriceSource, "lookup">;
  /** Where API keys are read from; defaults to the process environment. Keys are never stored. */
  env?: Record<string, string | undefined>;
  /**
   * Replaces the Judge's language model (recorded-response tests), bypassing
   * the vendor's provider, its base URL and `fetch`. Given the `vendor/model`
   * id and the API key it would have been called with.
   */
  languageModel?: (model: string, apiKey: string) => MastraModelConfig;
  /**
   * The network under the vendor's provider (fake-vendor tests); defaults to
   * `fetch`. Each request arrives with Bun's idle timeout already turned off.
   */
  fetch?: JudgeFetch;
  /** A call still running after this long is aborted (default per effort, `JUDGE_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * The verdict's JSON Schema for structured output. Its objects are open
 * (`additionalProperties: true`), so Mastra sends OpenAI a non-strict schema;
 * Mastra's Anthropic provider strips unsupported bounds and closes objects
 * regardless. The local decode below enforces the whole schema either way.
 */
const verdictSchema = toMastraSchema(JudgeVerdict);
const decodeVerdict = Schema.decodeUnknownSync(JudgeVerdict);
const decodeVerdictText = Schema.decodeUnknownSync(Schema.fromJsonString(JudgeVerdict));
const rubric = CURRENT_RUBRIC;
const instructions = judgeInstructions(rubric);
/** Text sent with every call: the instructions and the verdict schema as Mastra sends it. */
const prompt =
  instructions +
  JSON.stringify(verdictSchema["~standard"].jsonSchema.input({ target: "draft-07" }));

/** The token counts of a usage report that are numbers, as stored. */
function usageOf(usage: Record<string, unknown> | undefined): Usage | null {
  if (!usage) return null;
  const counts = Object.entries(usage).filter((entry): entry is [string, number] =>
    Number.isFinite(entry[1]),
  );
  return counts.length === 0 ? null : Object.fromEntries(counts);
}

/**
 * The actual cost of a call from its usage report, or null when input or
 * output tokens are missing. Mastra's usage counts reasoning (Anthropic
 * thinking, Gemini thoughts, OpenAI reasoning) in `outputTokens`.
 */
function costOf(pricing: typeof LlmPricing.Type, usage: Usage | null) {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  return llmCostMicros(pricing, { inputTokens, outputTokens });
}

/** Network error codes that show the request never reached the vendor, so it wasn't billed. */
const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ConnectionRefused", "ECONNREFUSED"]);

/**
 * Codes Bun and Node give their own argument errors (e.g. `ERR_INVALID_URL`,
 * `ERR_MISSING_ARGS`): local, not network. Only `ERR_INVALID_URL` proves
 * nothing was sent (fetch rejects the URL before connecting); others, such as
 * `ERR_INVALID_STATE` or `ERR_INVALID_ARG_TYPE` from stream or buffer misuse,
 * can come after a billed response.
 */
const LOCAL_CODE = /^ERR_(INVALID_|.*_ARGS?(_|$))/;
const NOT_SENT_LOCAL_CODES = new Set(["ERR_INVALID_URL"]);

/** An error's message, or a marker when the vendor sent an empty body. */
const messageOf = (error: unknown) => errorMessage(error) || "(empty body)";

/**
 * A thrown model error as a result:
 * - an HTTP error status (400 and up) is the vendor's answer, not billed, so
 *   $0: transient when retrying can help, else failed;
 * - a local programming error (a TypeError, SyntaxError or RangeError with no
 *   code, or a Bun/Node argument code such as `ERR_INVALID_URL`) is failed and
 *   not retried: at $0 for `ERR_INVALID_URL`, thrown before anything is sent;
 *   otherwise at unknown cost, since it may have been thrown while handling a
 *   response that was already billed;
 * - a network error (any other `code` on the error or its causes, e.g. Bun's
 *   ENOTFOUND or ECONNRESET) is transient, at $0 when its code shows nothing
 *   was sent, else at unknown cost;
 * - anything else, including a 2xx whose body broke off (vendors bill a
 *   request that was on track to succeed), is transient at unknown cost.
 */
function classifyError(error: unknown, redact: (text: string) => string): JudgeCallResult {
  const status = statusOf(error);
  if (status !== undefined && status >= 400) {
    return httpErrorResult(status, redact(`Judge HTTP ${status}: ${messageOf(error)}`));
  }
  const code = codeOf(error);
  const local =
    status === undefined &&
    (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) &&
    (code === undefined || LOCAL_CODE.test(code));
  if (local) {
    return {
      kind: "failed",
      reason: redact(`Judge call failed locally: ${messageOf(error)}`),
      usage: null,
      costMicros: code !== undefined && NOT_SENT_LOCAL_CODES.has(code) ? 0 : null,
    };
  }
  if (code !== undefined) {
    return {
      kind: "transient",
      reason: redact(`Judge request failed (${code}): ${messageOf(error)}`),
      costMicros: NOT_SENT_CODES.has(code) ? 0 : null,
    };
  }
  return {
    kind: "transient",
    reason: redact(`Judge request failed: ${messageOf(error)}`),
    costMicros: null,
  };
}

/** The first line of a schema error and the path it is at, as one line. */
const firstIssue = (error: unknown) =>
  errorMessage(error)
    .split("\n")
    .slice(0, 2)
    .map((line) => line.trim())
    .join(" ");

/**
 * A generation as a result, with its cost from the usage report: a content
 * filter is a refusal; an answer cut off at the output cap, an empty answer
 * or one that doesn't decode against the verdict schema (the structured
 * object, else the text as JSON) fails the judging, saying which.
 */
function classifyResult(
  result: { usage?: unknown; finishReason?: string | undefined; object?: unknown; text: string },
  pricing: typeof LlmPricing.Type,
  outputCap: number,
): JudgeCallResult {
  const usage = usageOf(result.usage as Record<string, unknown> | undefined);
  const costMicros = costOf(pricing, usage);
  const failed = (reason: string): JudgeCallResult => ({
    kind: "failed",
    reason,
    usage,
    costMicros,
  });
  if (result.finishReason === "content-filter") {
    return { kind: "refused", reason: "The Judge declined (content filter)", usage, costMicros };
  }
  if (result.finishReason === "length") {
    return failed(
      `The Judge hit its ${outputCap}-token output cap, reasoning included, before finishing its answer`,
    );
  }
  if (result.object === undefined && result.text.trim() === "") {
    return failed("The Judge gave an empty answer");
  }
  try {
    const verdict =
      result.object === undefined ? decodeVerdictText(result.text) : decodeVerdict(result.object);
    return { kind: "judged", verdict, usage, costMicros };
  } catch (error) {
    return failed(
      `The Judge's answer doesn't match the Rubric's verdict schema: ${firstIssue(error)}`,
    );
  }
}

/**
 * The Judges behind Mastra agents on their vendor's AI SDK provider, selected
 * by `vendor/model` id. Getting one checks the vendor, its API key and its LLM
 * price first, so a Run fails before any billable call. Each call is one
 * structured-output generation with the vendor's reasoning effort and an
 * output cap; Mastra's own retries are off, since the engine retries each
 * attempt as a reserved, billed call. Only the Rubric, the Reference Photos,
 * the Candidate and the Target Look are sent, to the vendor's own API
 * endpoint; nothing is stored by Mastra.
 */
export const MastraJudges = (options: MastraJudgesOptions) =>
  Layer.succeed(Judges)({
    get: ({ model, effort }, recorded) =>
      Effect.gen(function* () {
        const judgeModel = parseJudgeModel(model);
        if (judgeModel === undefined) {
          return yield* new JudgeUnavailable({
            model,
            message: `No Judge for "${model}"; the Judge is an anthropic/, openai/ or google/ model`,
          });
        }
        const { vendor } = judgeModel;
        const read = apiKeyFromEnv(options.env ?? process.env, judgeKeys[vendor], model);
        if ("problem" in read) return yield* new JudgeUnavailable({ model, message: read.problem });
        const apiKey = read.key;
        const imageTokens = judgeImageTokens(model);
        if (imageTokens === undefined) {
          return yield* new JudgeUnavailable({
            model,
            message: `${model} has no documented upper bound on its image tokens, so its calls can't be estimated within the Budget; choose another Judge`,
          });
        }
        const priceModel = judgePriceModel(model);
        if (recorded && recorded.model !== priceModel) {
          return yield* new Unpriced({
            model,
            reason: `the recorded price is for ${recorded.model}`,
          });
        }
        const price =
          recorded ??
          (yield* options.prices
            .lookup(priceModel)
            .pipe(
              Effect.catchTag("PriceStoreError", (error) =>
                Effect.fail(new JudgeUnavailable({ model, message: errorMessage(error) })),
              ),
            ));
        const { pricing } = price;
        if (pricing._tag !== "Llm") {
          return yield* new Unpriced({ model, reason: `priced as ${pricing._tag}, not as an LLM` });
        }

        const agent = new Agent({
          id: "judge",
          name: "Judge",
          instructions,
          model:
            options.languageModel?.(model, apiKey) ??
            judgeLanguageModel(vendor, judgeModel.id, apiKey, options.fetch ?? fetch),
          // The engine retries: each attempt is reserved against the Budget first.
          errorProcessorDefaults: false,
        });
        agent.__setLogger(noopLogger);
        const providerOptions = reasoningOptions(vendor, effort);
        const redact = redactKey(apiKey);
        const outputCap = JUDGE_MAX_OUTPUT_TOKENS[effort];
        const timeoutMs = options.timeoutMs ?? judgeTimeoutMs(effort);
        const timedOut: JudgeCallResult = {
          kind: "transient",
          reason: `Judge request timed out after ${timeoutMs / 1000} s`,
          costMicros: null,
        };

        const call = (request: JudgeRequest) =>
          Effect.suspend(() => {
            const timeout = AbortSignal.timeout(timeoutMs);
            return Effect.tryPromise({
              try: (signal) =>
                agent.generate(
                  [
                    {
                      role: "user",
                      content: judgeMessage(request).map((part) =>
                        part.kind === "text"
                          ? { type: "text" as const, text: part.text }
                          : {
                              type: "image" as const,
                              image: part.image.bytes,
                              mediaType: part.image.mimeType,
                            },
                      ),
                    },
                  ],
                  {
                    structuredOutput: { schema: verdictSchema, errorStrategy: "warn" },
                    providerOptions,
                    modelSettings: { maxOutputTokens: outputCap, maxRetries: 0 },
                    abortSignal: AbortSignal.any([signal, timeout]),
                  },
                ),
              catch: (error) => error,
            }).pipe(
              Effect.match({
                // Mastra resolves an aborted generation with an empty result.
                onSuccess: (result) =>
                  timeout.aborted ? timedOut : classifyResult(result, pricing, outputCap),
                onFailure: (error): JudgeCallResult => {
                  const abortLike =
                    hasErrorNamed(error, "TimeoutError") || hasErrorNamed(error, "AbortError");
                  // Defensive, for a Mastra that rejects on abort instead of resolving: past the
                  // deadline, an abort error is the deadline's; a vendor answer still classifies.
                  if (timeout.aborted && abortLike) return timedOut;
                  // A TimeoutError our deadline didn't raise is a cut idle connection (Bun's
                  // fetch idle timeout, which the Judge turns off): name it, so it isn't taken
                  // for the deadline.
                  if (hasErrorNamed(error, "TimeoutError")) {
                    return {
                      kind: "transient",
                      reason: redact(
                        `Judge connection idle timeout, not the Judge's ${timeoutMs / 1000} s deadline: ${messageOf(error)}`,
                      ),
                      costMicros: null,
                    };
                  }
                  return classifyError(error, redact);
                },
              }),
            );
          });

        return {
          model,
          effort,
          price,
          rubric,
          estimate: (input) => estimateJudgeCall({ effort, imageTokens }, pricing, prompt, input),
          call,
        };
      }),
  });
