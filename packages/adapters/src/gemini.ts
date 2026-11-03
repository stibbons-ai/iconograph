/**
 * Gemini image generation through the native Interactions API (ADR-0004), not
 * the AI SDK. Request and response shapes were checked against Google's docs on
 * 2026-11-01:
 *
 * - API reference (v1beta, which lists `gemini-nano-banana-2.1`; the v1 model
 *   enum doesn't yet): https://ai.google.dev/api/interactions-api and its
 *   OpenAPI spec https://ai.google.dev/static/api/interactions.openapi.json
 * - Image generation (`response_format.image_size`, the `Api-Revision` header,
 *   up to 4 character references): https://ai.google.dev/gemini-api/docs/interactions/image-generation
 * - `store=false` and retention: https://ai.google.dev/gemini-api/docs/interactions#data-storage-and-retention
 * - Safety blocks (HTTP 400 with `error.code` `safety`, `jailbreak`,
 *   `prohibited_content` or `blocklist`): https://ai.google.dev/gemini-api/docs/interactions/safety-settings.
 *   Live, Nano Banana 2.1 also answered `content_blocked` ("Request blocked for an unspecified
 *   policy reason") to a public figure's photos (2026-11-01); it is not in that list.
 * - v1 rejects image input ("available in v1beta"), checked live on 2026-11-01.
 * - "If your request fails with a 400 or 500 error, you won't be charged":
 *   https://ai.google.dev/gemini-api/docs/billing. We read that as every HTTP
 *   error status (4xx and 5xx) and book them at $0.
 * - Retry only 408, 429 and 5xx: https://ai.google.dev/gemini-api/docs/troubleshooting
 * - 1120 input tokens per image at the default media resolution:
 *   https://ai.google.dev/gemini-api/docs/media-resolution
 *
 * The API key is sent only in the `x-goog-api-key` header and is redacted from
 * any error text before it can become a reason.
 */
import {
  type CallEstimate,
  type CallResult,
  type GeminiImagePricing,
  type ImageModel,
  type ImageModelCapabilities,
  type ImageRequest,
  type PriceQuote,
  toMicros,
  type Usage,
} from "@iconograph/domain";
import { Effect, Schema } from "effect";
import { errorMessage } from "./errors";
import {
  base64Of,
  Count,
  encodeOncePerRequest,
  isTransientStatus,
  parseJson,
  promptTokens,
} from "./vendor-http";

export const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
/** The response schema revision the request and parsing below follow (`steps`, `response_format`). */
export const GEMINI_API_REVISION = "2026-05-20";

/**
 * What the Gemini adapter declares. Lanes generate 2K, the only size priced
 * from the 2K image-token count (`outputPer2KImage`); every call returns at
 * most one image (ADR-0004).
 */
export const geminiCapabilities: ImageModelCapabilities = {
  maxCharacterReferences: 4,
  sizes: ["2K"],
  qualities: [],
};

/** Input tokens one reference image costs at the default media resolution (Gemini 3). */
const INPUT_TOKENS_PER_IMAGE = 1120;
/**
 * Text and thinking output the estimate allows per call. Thinking is on by
 * default for Nano Banana 2.1 and its length isn't known in advance; 4000
 * tokens at the output text price is a deliberately generous upper guess,
 * since an estimate below the actual cost lets parallel calls overshoot the
 * Budget. Not yet calibrated: no live call has returned an image.
 */
const TEXT_AND_THINKING_ALLOWANCE = 4000;

/** Error codes of a policy block; the request is refused, not retried. */
const safetyCodes: Record<string, true> = {
  safety: true,
  jailbreak: true,
  prohibited_content: true,
  blocklist: true,
  content_blocked: true,
};
const isSafetyCode = (code: string | undefined) =>
  code !== undefined && Object.hasOwn(safetyCodes, code);

export type GeminiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiImageModelOptions {
  model: string;
  apiKey: string;
  /** A quote whose pricing is in Gemini image mode. */
  price: PriceQuote & { pricing: GeminiImagePricing };
  fetch?: GeminiFetch;
  /** Abort one call (including its body) after this long; default 180 s. */
  timeoutMs?: number;
}

const GeminiUsage = Schema.Struct({
  total_input_tokens: Schema.optionalKey(Count),
  total_output_tokens: Schema.optionalKey(Count),
  total_thought_tokens: Schema.optionalKey(Count),
  output_tokens_by_modality: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        modality: Schema.optionalKey(Schema.String),
        tokens: Schema.optionalKey(Count),
      }),
    ),
  ),
});

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  mime_type: Schema.optionalKey(Schema.String),
});

const Interaction = Schema.Struct({
  status: Schema.String,
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        content: Schema.optionalKey(Schema.Array(ContentBlock)),
      }),
    ),
  ),
  usage: Schema.optionalKey(GeminiUsage),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
    message: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
  }),
});

const decodeInteraction = Schema.decodeUnknownOption(Interaction);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/**
 * Our usage names for Gemini's token counts, keeping only what Gemini reported.
 * `total_output_tokens` excludes thinking: the spec's `Interaction` example
 * has total_input_tokens 7, total_output_tokens 23, total_thought_tokens 49
 * and total_tokens 79 = 7 + 23 + 49, so adding thoughts on top doesn't
 * double-count them.
 *
 * `complete` says the counts price the call without undercounting: input,
 * output and thought totals are present; the output is 0, or its split by
 * modality is present, non-empty, counts every entry and adds up to the output
 * total; and when the response holds any image block, the split counts image
 * tokens. Otherwise image tokens could be priced at the text rate. A text-only
 * answer may list no image entry (Google's documented example). The text share
 * (`outputTextTokens`) is stored only when the split is complete.
 */
function usageOf(reported: typeof GeminiUsage.Type, hasImageBlock: boolean) {
  const input = reported.total_input_tokens;
  const output = reported.total_output_tokens;
  const thought = reported.total_thought_tokens;
  const split = reported.output_tokens_by_modality ?? [];
  const sumTokens = (entries: typeof split) =>
    entries.reduce((sum, { tokens = 0 }) => sum + tokens, 0);
  const everyEntryCounted = split.every(({ tokens }) => tokens !== undefined);
  const splitTotal = sumTokens(split);
  const imageEntries = split.filter(({ modality }) => modality === "image");
  const image = imageEntries.length > 0 && everyEntryCounted ? sumTokens(imageEntries) : undefined;
  const splitComplete =
    output === 0 || (split.length > 0 && everyEntryCounted && splitTotal === output);
  const usage: Usage = {
    ...(input !== undefined && { inputTokens: input }),
    ...(image !== undefined && { outputImageTokens: image }),
    ...(output !== undefined && splitComplete && { outputTextTokens: output - (image ?? 0) }),
    ...(thought !== undefined && { thoughtTokens: thought }),
  };
  const complete =
    input !== undefined &&
    output !== undefined &&
    thought !== undefined &&
    splitComplete &&
    (!hasImageBlock || image !== undefined);
  return { usage, complete };
}

/**
 * USD micros for Gemini usage: input tokens at the input price, output image
 * tokens at the image price, output text and thinking at the text price.
 */
function geminiCostMicros(usage: Usage, pricing: GeminiImagePricing): number {
  const count = (name: string) => usage[name] ?? 0;
  return toMicros(
    count("inputTokens") * pricing.inputPerToken +
      count("outputImageTokens") * pricing.outputPerImageToken +
      (count("outputTextTokens") + count("thoughtTokens")) * pricing.outputPerToken,
  );
}

/**
 * Classify a 200 response body. Only a model that answered with text and no
 * image block declined; any other missing image is a parser or shape problem
 * and Fails. Every 200 may have been billed: without a complete usage report
 * (see `usageOf`) its cost is unknown (null), never priced too low.
 */
function classifyInteraction(body: unknown, pricing: GeminiImagePricing): CallResult {
  const decoded = decodeInteraction(body);
  if (decoded._tag === "None") {
    return {
      kind: "failed",
      reason: "Gemini returned a malformed interaction",
      usage: null,
      costMicros: null,
    };
  }
  const interaction = decoded.value;
  const blocks = (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? []);
  const hasImageBlock = blocks.some((block) => block.type === "image");
  const reported = interaction.usage ? usageOf(interaction.usage, hasImageBlock) : null;
  const usage = reported?.usage ?? null;
  const costMicros = reported?.complete === true ? geminiCostMicros(reported.usage, pricing) : null;
  const failed = (reason: string): CallResult => ({ kind: "failed", reason, usage, costMicros });

  const errors = interaction.errors ?? [];
  const blocked = errors.find(({ code }) => isSafetyCode(code));
  if (blocked) {
    return {
      kind: "refused",
      reason: `${blocked.code}: ${blocked.message ?? "blocked"}`,
      usage,
      costMicros,
    };
  }
  if (interaction.status !== "completed") {
    const detail = errors
      .map(({ code, message }) => [code, message].filter(Boolean).join(": "))
      .join("; ");
    return failed(`Gemini interaction ${interaction.status}${detail ? `: ${detail}` : ""}`);
  }
  if (blocks.length === 0) return failed("Gemini returned no model output");
  // The last image is the final one; earlier ones can be drafts.
  const image = [...blocks].reverse().find((block) => block.type === "image");
  if (image) {
    if (image.data === undefined) return failed("Gemini returned an image without inline data");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length === 0) return failed("Gemini returned an empty image");
    return {
      kind: "image",
      image: { bytes, mimeType: image.mime_type ?? "image/jpeg" },
      usage,
      costMicros,
    };
  }
  const text = blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join(" ")
    .trim();
  if (!text) return failed("Gemini returned neither an image nor text");
  // The model answered with text only: it declined. Its text is the reason.
  return { kind: "refused", reason: text, usage, costMicros };
}

/** Classify an HTTP error response; Google doesn't charge HTTP errors, so they cost $0. */
function classifyHttpError(status: number, body: unknown): CallResult {
  const decoded = decodeErrorBody(body);
  const error = decoded._tag === "Some" ? decoded.value.error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = error?.message ?? "no error message";
  if (status === 400 && isSafetyCode(code)) {
    return { kind: "refused", reason: `${code}: ${message}`, usage: null, costMicros: 0 };
  }
  const reason = `Gemini HTTP ${status}${error?.status ? ` ${error.status}` : ""}: ${message}`;
  return isTransientStatus(status)
    ? { kind: "transient", reason, costMicros: 0 }
    : { kind: "failed", reason, usage: null, costMicros: 0 };
}

/**
 * One Gemini Image Model. Each `call` is one interaction with `store: false`
 * and one inline 2K image response; Gemini has no `n`, so N Candidates are N calls.
 */
export function geminiImageModel(options: GeminiImageModelOptions): ImageModel {
  const { model, apiKey, price, fetch: send = fetch, timeoutMs = 180_000 } = options;
  const { pricing } = price;
  /** Error text with the key removed, e.g. from a runtime rejecting the header value. */
  const redact = (text: string) => (apiKey ? text.replaceAll(apiKey, "[redacted]") : text);

  const estimate = (request: ImageRequest): CallEstimate => {
    const usage = {
      inputTokens:
        request.references.length * INPUT_TOKENS_PER_IMAGE + promptTokens(request.prompt),
      outputImageTokens: 0,
      outputTextTokens: TEXT_AND_THINKING_ALLOWANCE,
      thoughtTokens: 0,
    };
    return {
      usage,
      micros: geminiCostMicros(usage, pricing) + toMicros(pricing.outputPer2KImage),
    };
  };

  const bodyOf = encodeOncePerRequest((request) =>
    JSON.stringify({
      model,
      input: [
        { type: "text", text: request.prompt },
        ...request.references.map(({ bytes, mimeType }) => ({
          type: "image",
          mime_type: mimeType,
          data: base64Of(bytes),
        })),
      ],
      response_format: {
        type: "image",
        image_size: request.size,
        mime_type: "image/jpeg",
        delivery: "inline",
      },
      store: false,
    }),
  );

  // Interrupting the Effect aborts the request, as does the per-call timeout.
  const call = (request: ImageRequest) =>
    Effect.promise(async (interrupted): Promise<CallResult> => {
      let response: Response;
      let text: string;
      try {
        response = await send(GEMINI_INTERACTIONS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
            "api-revision": GEMINI_API_REVISION,
          },
          body: bodyOf(request),
          signal: AbortSignal.any([interrupted, AbortSignal.timeout(timeoutMs)]),
        });
        text = await response.text();
      } catch (error) {
        // No usable response: the request may still have been processed and billed.
        return {
          kind: "transient",
          reason: redact(`Gemini request failed: ${errorMessage(error)}`),
          costMicros: null,
        };
      }
      const json = parseJson(text);
      const result = response.ok
        ? classifyInteraction(json, pricing)
        : classifyHttpError(response.status, json);
      return "reason" in result ? { ...result, reason: redact(result.reason) } : result;
    });

  return { model, capabilities: geminiCapabilities, price, estimate, call };
}
