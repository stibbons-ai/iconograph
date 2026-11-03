import {
  apiKeyFromEnv,
  codeOf,
  errorMessage,
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
  judgeVendor,
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
 * The provider options setting a role's effort through each vendor's reasoning
 * parameter, as Mastra's model router passes them on (checked against Mastra
 * 1.80's provider options): Anthropic `effort`, OpenAI `reasoningEffort`,
 * Gemini `thinkingConfig.thinkingLevel`.
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
   * Replaces the model router's network model (recorded-response tests). Given
   * the router id and the API key it would have been called with.
   */
  languageModel?: (model: string, apiKey: string) => MastraModelConfig;
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

/** Bun's default fetch idle timeout when `BUN_CONFIG_HTTP_IDLE_TIMEOUT` isn't set: 5 minutes. */
const BUN_DEFAULT_IDLE_TIMEOUT_S = 300;

/**
 * Bun's fetch idle timeout for this process. Bun reads the variable once, from
 * the OS environment at start (not from a `.env` file), as whole seconds; any
 * other value leaves the default. Calls are non-streaming, so no bytes arrive
 * until the answer is done, and a call running longer than this is cut off.
 */
function bunIdleTimeoutMs(env: Record<string, string | undefined>): number {
  const value = env.BUN_CONFIG_HTTP_IDLE_TIMEOUT?.trim() ?? "";
  return (/^[1-9]\d*$/.test(value) ? Number(value) : BUN_DEFAULT_IDLE_TIMEOUT_S) * 1000;
}

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

/** A URL's origin for messages: no path, query or userinfo (which may hold a token). */
function originOf(url: string): string {
  if (url === "") return "empty";
  try {
    return new URL(url).origin;
  } catch {
    return "not a URL";
  }
}

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
 * The Judges behind Mastra agents on the model router, selected by router id
 * (`vendor/model`). Getting one checks the vendor, its API key and its LLM
 * price first, so a Run fails before any billable call. Each call is one
 * structured-output generation with the vendor's reasoning effort and an
 * output cap; Mastra's own retries are off, since the engine retries each
 * attempt as a reserved, billed call. Only the Rubric, the Reference Photos,
 * the Candidate and the Target Look are sent; nothing is stored by Mastra.
 */
export const MastraJudges = (options: MastraJudgesOptions) =>
  Layer.succeed(Judges)({
    get: ({ model, effort }, recorded) =>
      Effect.gen(function* () {
        const vendor = judgeVendor(model);
        if (vendor === undefined) {
          return yield* new JudgeUnavailable({
            model,
            message: `No Judge for "${model}"; the Judge is an anthropic/, openai/ or google/ model router id`,
          });
        }
        const env = options.env ?? process.env;
        const read = apiKeyFromEnv(env, judgeKeys[vendor], model);
        if ("problem" in read) return yield* new JudgeUnavailable({ model, message: read.problem });
        const apiKey = read.key;
        // Mastra's router sends a vendor's calls to `<VENDOR>_BASE_URL` when it is set: the key and
        // the Reference Photos would go there instead of the vendor.
        const baseUrlVariable = `${vendor.toUpperCase()}_BASE_URL`;
        // Set at all, even empty: an empty value becomes an invalid relative base URL.
        const baseUrl = env[baseUrlVariable];
        if (baseUrl !== undefined) {
          return yield* new JudgeUnavailable({
            model,
            message: `${baseUrlVariable} is set (${originOf(baseUrl)}); the Judge would send its key and the Reference Photos there instead of ${vendor}. Unset it (even an empty value counts) to run the Judge`,
          });
        }
        const timeoutMs = options.timeoutMs ?? judgeTimeoutMs(effort);
        const idleMs = bunIdleTimeoutMs(env);
        if (idleMs <= timeoutMs) {
          return yield* new JudgeUnavailable({
            model,
            message: `Bun's fetch idle timeout (BUN_CONFIG_HTTP_IDLE_TIMEOUT, ${idleMs / 1000} s) would cut off a ${effort}-effort Judge call before its ${timeoutMs / 1000} s timeout; start with \`bun run run\`, or start Bun with BUN_CONFIG_HTTP_IDLE_TIMEOUT above ${timeoutMs / 1000} (whole seconds) in the OS environment; a .env file is read too late`,
          });
        }
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

        // Any router id: the vendor was checked above; the model router resolves the rest.
        const routed: MastraModelConfig = { id: model as `${string}/${string}`, apiKey };
        const agent = new Agent({
          id: "judge",
          name: "Judge",
          instructions,
          model: options.languageModel?.(model, apiKey) ?? routed,
          // The engine retries: each attempt is reserved against the Budget first.
          errorProcessorDefaults: false,
        });
        agent.__setLogger(noopLogger);
        const providerOptions = reasoningOptions(vendor, effort);
        const redact = redactKey(apiKey);
        const outputCap = JUDGE_MAX_OUTPUT_TOKENS[effort];
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
                // Mastra resolves an aborted generation with an empty result instead of failing.
                onSuccess: (result) =>
                  timeout.aborted ? timedOut : classifyResult(result, pricing, outputCap),
                onFailure: (error) => classifyError(error, redact),
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
