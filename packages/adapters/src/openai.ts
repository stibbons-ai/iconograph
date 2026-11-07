/**
 * OpenAI image generation through the native Images API edits endpoint
 * (ADR-0004), not the AI SDK. Request and response shapes were checked against
 * OpenAI's docs on 2026-11-02:
 *
 * - API reference, `POST /v1/images/edits`: https://developers.openai.com/api/reference/resources/images/methods/edit.
 *   JSON body (`application/json`) with `images: [{ image_url }]` (a base64
 *   data URL; up to 16 images for GPT Image models), `prompt` (up to 32,000
 *   characters), `quality` (`high`), `size` (`1024x1024` is the standard
 *   square), `n` (default 1), `output_format` (`jpeg`). The response holds
 *   `data[].b64_json` and `usage` (`input_tokens`,
 *   `input_tokens_details.{text_tokens,image_tokens}`, `output_tokens`,
 *   optionally `output_tokens_details`). The reference describes `usage` as
 *   "for `gpt-image-1` only", while the image generation guide says to use the
 *   response's usage; a response without it costs as unknown.
 * - Image generation guide: https://developers.openai.com/api/docs/guides/image-generation.
 *   Moderation blocks are errors with `error.code` `moderation_blocked` (type
 *   `image_generation_user_error`, optional `moderation_details` with
 *   `moderation_stage` and `categories`); user errors aren't to be retried.
 *   Its token calculator (`GptImageTokenCalculator`, GPT Image 2.5 at `high`
 *   with base 48) gives 1756 output image tokens for a 1024x1024 image.
 * - Error codes: https://developers.openai.com/api/docs/guides/error-codes.
 *   Retry 429 rate limits and 500/503 with backoff; never quota, credit or
 *   spend-limit 429s (`insufficient_quota`, `credit_balance_exhausted`,
 *   `*_spend_limit_exceeded`, `organization_usage_limit_exceeded`).
 * - Pricing: https://developers.openai.com/api/docs/pricing#image-generation
 *   and the model page https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst:
 *   text input, image input and image output tokens; "Text output is not
 *   billed because this model outputs images".
 * - Billing of failed requests: none of those pages, nor the help center,
 *   says whether an HTTP error is billed. A moderation block may come after
 *   the image was generated (`moderation_stage: output`), so an HTTP error's
 *   cost is unknown (null) and counts at its estimate, never as free.
 *
 * The API key is sent only in the `Authorization` header and is redacted from
 * any error text before it can become a reason, as are masked echoes of a key
 * in the usual form OpenAI's 401 uses (`Incorrect API key provided: sk-proj-****abcd`):
 * a word with three or more asterisks inside, whatever its prefix. Masks in
 * other forms are not recognised.
 */
import {
  type CallEstimate,
  type CallResult,
  type ImageModel,
  type ImageModelCapabilities,
  type ImageRequest,
  type OpenAIImagePricing,
  type PriceQuote,
  toMicros,
  type Usage,
} from "@iconograph/domain";
import { Effect, Schema } from "effect";
import { redactReason } from "./api-key";
import { errorMessage, field } from "./errors";
import {
  base64Of,
  Count,
  encodeOncePerRequest,
  isTransientStatus,
  parseJson,
  promptTokens,
} from "./vendor-http";

export const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";

/**
 * What the OpenAI adapter declares: up to 16 reference images, a square
 * 1024x1024 image at high quality, one image per call (ADR-0004).
 */
export const openaiCapabilities: ImageModelCapabilities = {
  maxCharacterReferences: 16,
  sizes: ["1024x1024"],
  qualities: ["high"],
};

/** Output image tokens of a high-quality 1024x1024 image (OpenAI's GPT Image 2.5 calculator). */
const OUTPUT_TOKENS_PER_IMAGE = 1756;
/**
 * Input image tokens the estimate allows per reference. OpenAI doesn't
 * document how GPT Image 2.5 tokenizes input images. A reference is sent at
 * most 2048 px on its longest side, which 32 px patches cover with at most
 * 64 × 64 = 4096 patches (the vision guide's patch rule); 1.5× that allows for
 * a per-model multiplier. Deliberately generous, since an estimate below the
 * actual cost lets parallel calls overshoot the Budget; not yet calibrated.
 */
const INPUT_TOKENS_PER_REFERENCE = 6144;
/**
 * Fewer output tokens than this can't be a real image: the calculator's
 * smallest (low quality, 1024x1024) takes 196, and ours are high quality. A
 * report below it is implausible, so the image's cost is unknown, not tiny.
 * The floor is the calculator's low-quality base of 16, far below 196 on
 * purpose: a safety margin, not the smallest image, so don't raise it to 196.
 */
const MIN_OUTPUT_TOKENS_PER_IMAGE = 16;

/** Error codes of a moderation block; the request is refused, not retried. */
const MODERATION_CODE = "moderation_blocked";
/** 429 codes that retrying can't fix: no credit, or a spend or usage limit. */
const quotaCodes: Record<string, true> = {
  insufficient_quota: true,
  credit_balance_exhausted: true,
  billing_hard_limit_reached: true,
  organization_spend_limit_exceeded: true,
  project_spend_limit_exceeded: true,
  organization_usage_limit_exceeded: true,
};

export type OpenAIFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIImageModelOptions {
  model: string;
  apiKey: string;
  /** A quote whose pricing is in OpenAI image mode. */
  price: PriceQuote & { pricing: OpenAIImagePricing };
  fetch?: OpenAIFetch;
  /** Abort one call (including its body) after this long; default 300 s. */
  timeoutMs?: number;
}

/** A token count; null or absent means not reported. */
const Reported = Schema.optionalKey(Schema.NullOr(Count));

const TokenDetails = Schema.Struct({ text_tokens: Reported, image_tokens: Reported });

const OpenAIUsage = Schema.Struct({
  input_tokens: Reported,
  input_tokens_details: Schema.optionalKey(Schema.NullOr(TokenDetails)),
  output_tokens: Reported,
});

/**
 * The fields a 200 must get right. Side fields (`usage`, `output_format`) and
 * the entries after the first image are decoded on their own or not at all, so
 * an odd one can't throw away a billed image.
 */
const ImagesResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  output_format: Schema.optionalKey(Schema.Unknown),
  usage: Schema.optionalKey(Schema.Unknown),
});

/** Every error field is read on its own, so an odd one can't hide a moderation block. */
const ErrorBody = Schema.Struct({ error: Schema.Record(Schema.String, Schema.Unknown) });

const decodeImagesResponse = Schema.decodeUnknownOption(ImagesResponse);
const decodeUsage = Schema.decodeUnknownOption(OpenAIUsage);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** A non-empty string, or undefined for anything else. */
const nonEmpty = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * Our usage names for OpenAI's token counts, keeping only what OpenAI
 * reported. `complete` says the counts price the call without undercounting:
 * the input total and its text/image split are present and add up, and the
 * output total is present. All output tokens are priced as image tokens: the
 * image rate is the only output rate, and text output isn't billed.
 */
function usageOf(reported: typeof OpenAIUsage.Type) {
  const input = reported.input_tokens ?? undefined;
  const text = reported.input_tokens_details?.text_tokens ?? undefined;
  const image = reported.input_tokens_details?.image_tokens ?? undefined;
  const output = reported.output_tokens ?? undefined;
  const usage: Usage = {
    ...(text !== undefined && { inputTextTokens: text }),
    ...(image !== undefined && { inputImageTokens: image }),
    ...(output !== undefined && { outputImageTokens: output }),
  };
  const complete =
    input !== undefined &&
    text !== undefined &&
    image !== undefined &&
    text + image === input &&
    output !== undefined;
  return { usage, complete };
}

/**
 * USD micros for OpenAI image usage: input text tokens at the text input
 * price, input image tokens at the image input price, output image tokens at
 * the image output price.
 */
function openaiCostMicros(usage: Usage, pricing: OpenAIImagePricing): number {
  const count = (name: string) => usage[name] ?? 0;
  return toMicros(
    count("inputTextTokens") * pricing.inputPerToken +
      count("inputImageTokens") * pricing.inputPerImageToken +
      count("outputImageTokens") * pricing.outputPerImageToken,
  );
}

/**
 * Classify a 200 response body. Every 200 may have been billed: without a
 * complete usage report its cost is unknown (null), never priced too low. A
 * returned image took output tokens, so a report of none is incomplete too.
 */
function classifyImages(body: unknown, pricing: OpenAIImagePricing): CallResult {
  const decoded = decodeImagesResponse(body);
  if (decoded._tag === "None") {
    return {
      kind: "failed",
      reason: "OpenAI returned a malformed images response",
      usage: null,
      costMicros: null,
    };
  }
  const response = decoded.value;
  const reportedUsage = decodeUsage(response.usage);
  const reported = reportedUsage._tag === "Some" ? usageOf(reportedUsage.value) : null;
  const usage = reported?.usage ?? null;
  const costMicros = reported?.complete ? openaiCostMicros(reported.usage, pricing) : null;
  const failed = (reason: string): CallResult => ({ kind: "failed", reason, usage, costMicros });

  const first = response.data?.[0];
  if (first === undefined) return failed("OpenAI returned no image");
  const encoded = field(first, "b64_json");
  if (typeof encoded !== "string") return failed("OpenAI returned an image without b64_json data");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) return failed("OpenAI returned an empty image");
  // A type the image store can't take Fails the Candidate later.
  const mimeType = `image/${nonEmpty(response.output_format) ?? "jpeg"}`;
  const plausible = (usage?.outputImageTokens ?? 0) >= MIN_OUTPUT_TOKENS_PER_IMAGE;
  return {
    kind: "image",
    image: { bytes, mimeType },
    usage,
    costMicros: plausible ? costMicros : null,
  };
}

/**
 * Classify an HTTP error response. A moderation block is Refused with
 * OpenAI's reason; quota and spend-limit 429s are Failed; rate limits, 408
 * and 5xx are transient; anything else is Failed. Whether OpenAI bills an
 * error isn't documented, so its cost is unknown.
 */
function classifyHttpError(status: number, body: unknown): CallResult {
  const decoded = decodeErrorBody(body);
  const error = decoded._tag === "Some" ? decoded.value.error : {};
  const code = nonEmpty(error.code);
  const type = nonEmpty(error.type);
  const message = nonEmpty(error.message) ?? "no error message";
  if (code === MODERATION_CODE) {
    const details = error.moderation_details;
    const stage = nonEmpty(field(details, "moderation_stage"));
    const listed = field(details, "categories");
    const categories = Array.isArray(listed) ? listed.flatMap((name) => nonEmpty(name) ?? []) : [];
    const context = [
      stage && `stage ${stage}`,
      categories.length > 0 && `categories ${categories.join(", ")}`,
    ].filter(Boolean);
    return {
      kind: "refused",
      reason: `${code}: ${message}${context.length > 0 ? ` (${context.join("; ")})` : ""}`,
      usage: null,
      costMicros: null,
    };
  }
  const label = [type, code].filter(Boolean).join(" ");
  const reason = `OpenAI HTTP ${status}${label ? ` ${label}` : ""}: ${message}`;
  const quota =
    (code !== undefined && Object.hasOwn(quotaCodes, code)) || type === "insufficient_quota";
  return isTransientStatus(status) && !quota
    ? { kind: "transient", reason, costMicros: null }
    : { kind: "failed", reason, usage: null, costMicros: null };
}

/**
 * One OpenAI Image Model. Each `call` is one image edit with the Lane's
 * references, at high quality, square, one JPEG (`n: 1`); N Candidates are N
 * calls.
 */
export function openaiImageModel(options: OpenAIImageModelOptions): ImageModel {
  const { model, apiKey, price, fetch: send = fetch, timeoutMs = 300_000 } = options;
  const { pricing } = price;
  /** A reason fit to store (`redactReason`): without the key or a masked echo of one, cut. */
  const redact = redactReason(apiKey);

  const estimate = (request: ImageRequest): CallEstimate => {
    const usage = {
      inputTextTokens: promptTokens(request.prompt),
      inputImageTokens: request.references.length * INPUT_TOKENS_PER_REFERENCE,
      outputImageTokens: OUTPUT_TOKENS_PER_IMAGE,
    };
    return { usage, micros: openaiCostMicros(usage, pricing) };
  };

  const bodyOf = encodeOncePerRequest((request) =>
    JSON.stringify({
      model,
      prompt: request.prompt,
      images: request.references.map(({ bytes, mimeType }) => ({
        image_url: `data:${mimeType};base64,${base64Of(bytes)}`,
      })),
      quality: "high",
      size: request.size,
      n: 1,
      output_format: "jpeg",
    }),
  );

  // Interrupting the Effect aborts the request, as does the per-call timeout.
  const call = (request: ImageRequest) =>
    Effect.promise(async (interrupted): Promise<CallResult> => {
      let response: Response;
      let text: string;
      try {
        response = await send(OPENAI_IMAGE_EDITS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: bodyOf(request),
          signal: AbortSignal.any([interrupted, AbortSignal.timeout(timeoutMs)]),
        });
        text = await response.text();
      } catch (error) {
        // No usable response: the request may still have been processed and billed.
        return {
          kind: "transient",
          reason: redact(`OpenAI request failed: ${errorMessage(error)}`),
          costMicros: null,
        };
      }
      const json = parseJson(text);
      const result = response.ok
        ? classifyImages(json, pricing)
        : classifyHttpError(response.status, json);
      return "reason" in result ? { ...result, reason: redact(result.reason) } : result;
    });

  return { model, capabilities: openaiCapabilities, price, estimate, call };
}
