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
  responseBodyOf,
  statusOf,
  toMastraSchema,
} from "@iconograph/adapters";
import {
  callTimeoutMs,
  type Effort,
  llmCostMicros,
  type LlmPricing,
  llmPriceModel,
  type LlmVendor,
  MAX_OUTPUT_TOKENS,
  type LlmUnsuccessfulCall,
  parseLlmModel,
  type PriceQuote,
  Unpriced,
  type UnsuccessfulCall,
  type Usage,
} from "@iconograph/domain";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { noopLogger } from "@mastra/core/logger";
import { Effect, Schema } from "effect";

/**
 * What the language-model roles (Judge, Optimizer) share: a Mastra agent on
 * the vendor's own AI SDK provider (ADR-0013), its credentials and price,
 * reasoning effort, deadline, and how a call's result or error is classified
 * and costed. Each role adds its own message and output schema.
 */

/** The environment variables holding each vendor's key. */
const VENDOR_KEYS: { readonly [V in LlmVendor]: readonly [string, ...string[]] } = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
};

/**
 * Each vendor's API endpoint: the provider packages' own defaults, set
 * explicitly so `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`, which those
 * packages read when none is given, can't send the key and the request
 * elsewhere.
 */
export const LLM_BASE_URLS: { readonly [V in LlmVendor]: string } = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

/** `fetch` without Bun's `preconnect`: the network a role's provider sends through. */
export type LlmFetch = (
  input: string | URL | Request,
  init: BunFetchRequestInit,
) => Promise<Response>;

/** How a role's agents reach their vendors and prices; shared by the Judges and the Optimizers. */
export interface LlmAgentsOptions {
  /** Prices every model before it is used, under `llmPriceModel`. */
  prices: Pick<PriceSource, "lookup">;
  /** Where API keys are read from; defaults to the process environment. Keys are never stored. */
  env?: Record<string, string | undefined>;
  /**
   * Replaces the language model (recorded-response tests), bypassing the
   * vendor's provider, its base URL and `fetch`. Given the `vendor/model` id
   * and the API key it would have been called with.
   */
  languageModel?: (model: string, apiKey: string) => MastraModelConfig;
  /**
   * The network under the vendor's provider (fake-vendor tests); defaults to
   * `fetch`. Each request arrives with Bun's idle timeout already turned off.
   */
  fetch?: LlmFetch;
  /** A call still running after this long is aborted (default per effort, `callTimeoutMs`). */
  timeoutMs?: number;
}

/**
 * The language model from its vendor's AI SDK provider, called the way
 * Mastra's model router calls it (OpenAI through the Responses API). Calls are
 * non-streaming, so no bytes arrive until the answer is done: each request
 * turns off Bun's fetch idle timeout (300 s by default), leaving the
 * per-effort abort as the only deadline.
 */
function vendorLanguageModel(
  vendor: LlmVendor,
  modelId: string,
  apiKey: string,
  network: LlmFetch,
): MastraModelConfig {
  const settings = {
    apiKey,
    baseURL: LLM_BASE_URLS[vendor],
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
 * OpenAI `reasoningEffort`, Gemini `thinkingConfig.thinkingLevel`. Every
 * `Effort` level passes through unchanged; the eval harness's second-Judge
 * choices accept all three (checked 2026-11-08): gpt-6.1-sol's
 * `reasoning.effort` takes `low`, `medium`, `high`, `xhigh` and `max`, no
 * `none` (https://developers.openai.com/api/docs/models/gpt-6.1-sol), and
 * gemini-4-argon thinks at `low`, `medium` or `high`
 * (https://ai.google.dev/gemini-api/docs/models/gemini-4-argon).
 */
function reasoningOptions(vendor: LlmVendor, effort: Effort) {
  switch (vendor) {
    case "anthropic":
      return { anthropic: { effort } };
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
  }
}

/** A role's model with its credentials: its vendor, the key and the language model. */
interface LlmModel {
  readonly vendor: LlmVendor;
  readonly apiKey: string;
  readonly languageModel: MastraModelConfig;
}

/**
 * A role's model checked before anything billable: a supported vendor, then
 * its API key. `unavailable` builds the role's error from a message.
 */
export const llmModel = <E>(
  role: string,
  model: string,
  options: LlmAgentsOptions,
  unavailable: (message: string) => E,
) =>
  Effect.gen(function* () {
    const parsed = parseLlmModel(model);
    if (parsed === undefined) {
      return yield* Effect.fail(
        unavailable(
          `No ${role} for "${model}"; the ${role} is an anthropic/, openai/ or google/ model`,
        ),
      );
    }
    const { vendor, id } = parsed;
    const read = apiKeyFromEnv(options.env ?? process.env, VENDOR_KEYS[vendor], model);
    if ("problem" in read) return yield* Effect.fail(unavailable(read.problem));
    const { key } = read;
    return {
      vendor,
      apiKey: key,
      languageModel:
        options.languageModel?.(model, key) ??
        vendorLanguageModel(vendor, id, key, options.fetch ?? fetch),
    } satisfies LlmModel;
  });

/**
 * A role's LLM price: the one recorded at Run start (which must be this
 * model's), else a fresh lookup under `llmPriceModel`. A lookup that fails is
 * the role's `unavailable`; a price that isn't an LLM's is `Unpriced`.
 */
export const llmPrice = <E>(
  model: string,
  recorded: PriceQuote | undefined,
  options: LlmAgentsOptions,
  unavailable: (message: string) => E,
) =>
  Effect.gen(function* () {
    const priceModel = llmPriceModel(model);
    if (recorded && recorded.model !== priceModel) {
      return yield* new Unpriced({ model, reason: `the recorded price is for ${recorded.model}` });
    }
    const price =
      recorded ??
      (yield* options.prices
        .lookup(priceModel)
        .pipe(
          Effect.catchTag("PriceStoreError", (error) =>
            Effect.fail(unavailable(errorMessage(error))),
          ),
        ));
    const { pricing } = price;
    if (pricing._tag !== "Llm") {
      return yield* new Unpriced({ model, reason: `priced as ${pricing._tag}, not as an LLM` });
    }
    return { price, pricing };
  });

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

/**
 * HTTP statuses that turn a role away for good: a rejected key (401), no
 * credit left (402: Anthropic's `billing_error`, Gemini's `payment_required`),
 * no access to the model (403), no such model or endpoint (404).
 */
const NON_RECOVERABLE_STATUSES = new Set([401, 402, 403, 404]);

/** Google's error body (`google.rpc.Status`), as far as the reasons in its `details` go. */
const decodeGoogleErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        details: Schema.Array(Schema.Struct({ reason: Schema.optionalKey(Schema.String) })),
      }),
    }),
  ),
);

/**
 * Whether an HTTP error turns the role away for good: a status in
 * `NON_RECOVERABLE_STATUSES`, or Google's answer to a bad key, a 400 whose
 * body gives `error.details[].reason` `API_KEY_INVALID`. Any other 400 can be
 * specific to one request, so it only fails that call.
 */
function turnsRoleAway(status: number, error: unknown): boolean {
  if (NON_RECOVERABLE_STATUSES.has(status)) return true;
  if (status !== 400) return false;
  const body = decodeGoogleErrorBody(responseBodyOf(error));
  return (
    body._tag === "Some" &&
    body.value.error.details.some(({ reason }) => reason === "API_KEY_INVALID")
  );
}

/** An error's message, or a marker when the vendor sent an empty body. */
const messageOf = (error: unknown) => errorMessage(error) || "(empty body)";

/**
 * A thrown model error as a result:
 * - an HTTP error status (400 and up) is the vendor's answer, not billed, so
 *   $0: non-recoverable when it turns the role away for good (`turnsRoleAway`:
 *   401, 402, 403, 404, or Google's 400 for a bad key; `NonRecoverableCall`),
 *   else transient when retrying can help, else failed;
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
function classifyError(
  error: unknown,
  role: string,
  redact: (text: string) => string,
): LlmUnsuccessfulCall {
  const status = statusOf(error);
  if (status !== undefined && status >= 400) {
    const reason = redact(`${role} HTTP ${status}: ${messageOf(error)}`);
    return turnsRoleAway(status, error)
      ? { kind: "non-recoverable", reason, costMicros: 0 }
      : httpErrorResult(status, reason);
  }
  const code = codeOf(error);
  const local =
    status === undefined &&
    (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) &&
    (code === undefined || LOCAL_CODE.test(code));
  if (local) {
    return {
      kind: "failed",
      reason: redact(`${role} call failed locally: ${messageOf(error)}`),
      usage: null,
      costMicros: code !== undefined && NOT_SENT_LOCAL_CODES.has(code) ? 0 : null,
    };
  }
  if (code !== undefined) {
    return {
      kind: "transient",
      reason: redact(`${role} request failed (${code}): ${messageOf(error)}`),
      costMicros: NOT_SENT_CODES.has(code) ? 0 : null,
    };
  }
  return {
    kind: "transient",
    reason: redact(`${role} request failed: ${messageOf(error)}`),
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

/** What a call that answered cost: its usage report, and the cost priced from it. */
interface AnswerCost {
  readonly usage: Usage | null;
  readonly costMicros: number | null;
}

/** What a role made of a decoded answer: its success, or the problem that fails the call. */
export type ReadAnswer<S> =
  | { readonly _tag: "Accepted"; readonly success: S }
  | { readonly _tag: "Rejected"; readonly problem: string };

export interface LlmCallOptions<A, S> {
  /** The role's name in reasons, e.g. "Judge"; its agent's id is the name in lower case. */
  readonly role: string;
  readonly instructions: string;
  readonly model: LlmModel;
  readonly effort: Effort;
  readonly pricing: typeof LlmPricing.Type;
  /** Replaces the per-effort deadline (`callTimeoutMs`), e.g. in tests. */
  readonly timeoutMs: number | undefined;
  /** The structured-output schema the answer must decode against. */
  readonly schema: Schema.Codec<A, unknown>;
  /** How reasons name the schema, e.g. "the Rubric's verdict schema". */
  readonly schemaName: string;
  /** The role's success from a decoded answer, or the problem that fails the call. */
  readonly read: (answer: A, cost: AnswerCost) => ReadAnswer<S>;
}

/**
 * A role's agent (ADR-0013) and its single billable call: one
 * structured-output generation with the vendor's reasoning effort, the
 * effort's output cap and deadline, its result or error classified and costed
 * from the usage report. A content filter is a refusal; an answer cut off at
 * the output cap, empty, or not decoding against the schema (the structured
 * object, else the text as JSON) fails the call; otherwise `read` decides.
 * Mastra's own retries are off: the engine retries each attempt as a
 * reserved, billed call. Interrupting a call aborts the request. `prompt` is
 * the text sent with every call (the instructions and the schema as Mastra
 * sends it), for the role's estimate.
 */
export const llmCaller = <A, S extends object>(options: LlmCallOptions<A, S>) => {
  const { role, instructions, model, effort, pricing, schemaName, read } = options;
  const schema = toMastraSchema(options.schema);
  const decode = Schema.decodeUnknownSync(options.schema);
  const decodeText = Schema.decodeUnknownSync(Schema.fromJsonString(options.schema));
  const outputCap = MAX_OUTPUT_TOKENS[effort];
  const timeoutMs = options.timeoutMs ?? callTimeoutMs(effort);
  const agent = new Agent({
    id: role.toLowerCase(),
    name: role,
    instructions,
    model: model.languageModel,
    // The engine retries: each attempt is reserved against the Budget first.
    errorProcessorDefaults: false,
  });
  agent.__setLogger(noopLogger);
  const providerOptions = reasoningOptions(model.vendor, effort);
  const redact = redactKey(model.apiKey);
  const timedOut: UnsuccessfulCall = {
    kind: "transient",
    reason: `${role} request timed out after ${timeoutMs / 1000} s`,
    costMicros: null,
  };
  const classify = (result: {
    usage?: unknown;
    finishReason?: string | undefined;
    object?: unknown;
    text: string;
  }): S | UnsuccessfulCall => {
    const usage = usageOf(result.usage as Record<string, unknown> | undefined);
    const costMicros = costOf(pricing, usage);
    const failed = (reason: string): UnsuccessfulCall => ({
      kind: "failed",
      reason,
      usage,
      costMicros,
    });
    if (result.finishReason === "content-filter") {
      return {
        kind: "refused",
        reason: `The ${role} declined (content filter)`,
        usage,
        costMicros,
      };
    }
    if (result.finishReason === "length") {
      return failed(
        `The ${role} hit its ${outputCap}-token output cap, reasoning included, before finishing its answer`,
      );
    }
    if (result.object === undefined && result.text.trim() === "") {
      return failed(`The ${role} gave an empty answer`);
    }
    let answer: A;
    try {
      answer = result.object === undefined ? decodeText(result.text) : decode(result.object);
    } catch (error) {
      return failed(`The ${role}'s answer doesn't match ${schemaName}: ${firstIssue(error)}`);
    }
    const outcome = read(answer, { usage, costMicros });
    return outcome._tag === "Rejected" ? failed(outcome.problem) : outcome.success;
  };

  const call = (messages: Parameters<Agent["generate"]>[0]) =>
    Effect.suspend(() => {
      const timeout = AbortSignal.timeout(timeoutMs);
      return Effect.tryPromise({
        try: (signal) =>
          agent.generate(messages, {
            structuredOutput: { schema, errorStrategy: "warn" },
            providerOptions,
            modelSettings: { maxOutputTokens: outputCap, maxRetries: 0 },
            abortSignal: AbortSignal.any([signal, timeout]),
          }),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          // Mastra resolves an aborted generation with an empty result.
          onSuccess: (result) => (timeout.aborted ? timedOut : classify(result)),
          onFailure: (error): LlmUnsuccessfulCall => {
            const abortLike =
              hasErrorNamed(error, "TimeoutError") || hasErrorNamed(error, "AbortError");
            // Defensive, for a Mastra that rejects on abort instead of resolving: past the
            // deadline, an abort error is the deadline's; a vendor answer still classifies.
            if (timeout.aborted && abortLike) return timedOut;
            // A TimeoutError our deadline didn't raise is a cut idle connection (Bun's fetch
            // idle timeout, which the provider turns off): name it, so it isn't taken for the
            // deadline.
            if (hasErrorNamed(error, "TimeoutError")) {
              return {
                kind: "transient",
                reason: redact(
                  `${role} connection idle timeout, not the ${role}'s ${timeoutMs / 1000} s deadline: ${messageOf(error)}`,
                ),
                costMicros: null,
              };
            }
            return classifyError(error, role, redact);
          },
        }),
      );
    });
  return {
    prompt:
      instructions + JSON.stringify(schema["~standard"].jsonSchema.input({ target: "draft-07" })),
    call,
  };
};
