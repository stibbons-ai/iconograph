import { Schema } from "effect";
import { toMicros } from "./budget";
import type { CallEstimate } from "./image-model";
import type { LlmPricing } from "./prices";

/**
 * What the language-model roles (Judge, Optimizer) share: model ids, effort,
 * output caps, deadlines, token estimates and LLM pricing.
 */

/** How hard a role reasons; each vendor's reasoning parameter takes these levels. */
export const Effort = Schema.Literals(["low", "medium", "high"]);
export type Effort = typeof Effort.Type;

/** A language-model id: `vendor/model`, e.g. `anthropic/claude-sonnet-5-5`. */
export const LlmModelId = Schema.String.check(
  Schema.makeFilter((id: string) =>
    /^[a-z0-9-]+\/\S+$/.test(id)
      ? true
      : "Expected a vendor/model id such as anthropic/claude-sonnet-5-5",
  ),
);

/** The vendors a language-model role can come from. */
const LLM_VENDORS = ["anthropic", "openai", "google"] as const;
export type LlmVendor = (typeof LLM_VENDORS)[number];

/**
 * A `vendor/model` id split at its first `/` into its vendor and the vendor's
 * model id; undefined for any other vendor.
 */
export function parseLlmModel(
  model: string,
): { readonly vendor: LlmVendor; readonly id: string } | undefined {
  const slash = model.indexOf("/");
  const vendor = LLM_VENDORS.find((known) => known === model.slice(0, slash));
  return slash > 0 && vendor ? { vendor, id: model.slice(slash + 1) } : undefined;
}

/** A model id's vendor (the part before the first `/`), when it is a supported vendor. */
export function llmVendor(model: string): LlmVendor | undefined {
  return parseLlmModel(model)?.vendor;
}

/**
 * The id a language model is priced under: LiteLLM's key naming, which the
 * price source, its overrides and its snapshot use. Anthropic and OpenAI
 * models are keyed by their bare id, Gemini Developer API models by
 * `gemini/<id>`; any other vendor by the full `vendor/model` id.
 */
export function llmPriceModel(model: string): string {
  const parsed = parseLlmModel(model);
  switch (parsed?.vendor) {
    case "anthropic":
    case "openai":
      return parsed.id;
    case "google":
      return `gemini/${parsed.id}`;
    default:
      return model;
  }
}

/**
 * A call's output cap per effort, reasoning included (Anthropic's adaptive
 * thinking counts toward it); estimates assume it is used up.
 */
export const MAX_OUTPUT_TOKENS: { readonly [E in Effort]: number } = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
};

/**
 * How long a call may run per effort: room for its whole output cap at about
 * 30 tokens/s (4,096 → 180 s, 8,192 → 300 s, 16,384 → 600 s), so a long
 * reasoning pass isn't cut off, retried and billed again.
 */
const TIMEOUT_MS: { readonly [E in Effort]: number } = {
  low: 180_000,
  medium: 300_000,
  high: 600_000,
};

/** How long a call at this effort may run before it is aborted (`TIMEOUT_MS`). */
export function callTimeoutMs(effort: Effort): number {
  return TIMEOUT_MS[effort];
}

/**
 * Text tokens assumed: ASCII at 2.5 characters per token (Anthropic's current
 * tokenizer averages about that: "1M tokens is roughly 2.5M Unicode
 * characters"), and every UTF-16 code unit above U+007F as 2 tokens, above any
 * measured rate (CJK about 0.7 tokens per character, emoji and rare CJK up to
 * about 1.5), so free text in any script stays within the bound.
 */
const ASCII_CHARACTERS_PER_TOKEN = 2.5;
const NON_ASCII_TOKENS_PER_CODE_UNIT = 2;

export function textTokens(text: string): number {
  let nonAscii = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) nonAscii++;
  }
  return (
    Math.ceil((text.length - nonAscii) / ASCII_CHARACTERS_PER_TOKEN) +
    nonAscii * NON_ASCII_TOKENS_PER_CODE_UNIT
  );
}

/**
 * Prompts a vendor adds unseen (Anthropic's structured-output and thinking
 * system prompts are billed but their size unpublished): an estimate adds
 * this many input tokens, or 10% of the counted input if that is more.
 */
const HIDDEN_PROMPT_TOKENS = 1_000;
const HIDDEN_PROMPT_SHARE = 0.1;

/**
 * An upper-bound estimate of a call: the counted input tokens plus the margin
 * for prompts the vendor adds unseen, and the whole output cap for the
 * effort, at this LLM price.
 */
export function boundedEstimate(
  countedInputTokens: number,
  effort: Effort,
  pricing: typeof LlmPricing.Type,
): CallEstimate {
  const usage = {
    inputTokens:
      countedInputTokens +
      Math.max(HIDDEN_PROMPT_TOKENS, Math.ceil(countedInputTokens * HIDDEN_PROMPT_SHARE)),
    outputTokens: MAX_OUTPUT_TOKENS[effort],
  };
  return { micros: llmCostMicros(pricing, usage), usage };
}

/** What a language-model call costs at these token counts, in micro-dollars. */
export function llmCostMicros(
  pricing: typeof LlmPricing.Type,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): number {
  const usd =
    usage.inputTokens * pricing.inputPerToken + usage.outputTokens * pricing.outputPerToken;
  return toMicros(usd);
}
