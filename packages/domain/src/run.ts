import { Schema } from "effect";
import { isWholeMicros, toMicros } from "./budget";
import { MAX_REFERENCE_PHOTOS } from "./identity";
import { TargetLook } from "./target-look";

/** Issue #1 defaults: a $5 Budget and 3 Candidates per Iteration. */
export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_CANDIDATES = 3;
export const MAX_CANDIDATES = 8;
/**
 * The largest Budget: far above any M0 Run, and small enough that every
 * 6-decimal amount below it is exactly representable, so the whole-micros
 * check and the integer ledger stay exact.
 */
export const MAX_BUDGET_USD = 1_000_000;

/** The Image Model of the M0 Gemini Lane. */
export const GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";
/** The default Image Model of an OpenAI Lane. */
export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
/** The faster OpenAI Image Model, selectable per Lane. */
export const OPENAI_FLARE_IMAGE_MODEL = "gpt-image-2.5-flare";

/** The longest Prompt a Lane takes: OpenAI's image edit limit (32,000 characters). */
export const MAX_PROMPT_LENGTH = 32_000;

/** A number from 1, as photos and faces are numbered in the Reference Photo report. */
const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * One Lane of a Run: its Image Model, and optionally the Reference Photos it
 * may send (photo numbers; default all) and its initial Prompt (default the
 * one built from the frozen Target Look).
 */
export const LaneRequest = Schema.Struct({
  model: Schema.String,
  photos: Schema.optionalKey(
    Schema.Array(Ordinal).check(
      Schema.isMinLength(1),
      Schema.makeFilter((photos: readonly number[]) =>
        new Set(photos).size === photos.length ? true : "A Lane lists the same photo twice",
      ),
    ),
  ),
  prompt: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((prompt: string) =>
        prompt.trim() !== "" && prompt.length <= MAX_PROMPT_LENGTH
          ? true
          : `A Lane's Prompt must be 1 to ${MAX_PROMPT_LENGTH} characters and not blank`,
      ),
    ),
  ),
});
export type LaneRequest = typeof LaneRequest.Type;

/** Everything a Run starts from; stored with the Run and never changed. */
export const RunRequest = Schema.Struct({
  /** Reference Photo files, 1 to 8. */
  photos: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_REFERENCE_PHOTOS),
  ),
  /** The operator's face choice for photos showing several faces; one per photo. */
  faceChoices: Schema.Array(Schema.Struct({ photo: Ordinal, face: Ordinal })).check(
    Schema.makeFilter((choices: readonly { photo: number }[]) =>
      new Set(choices.map(({ photo }) => photo)).size === choices.length
        ? true
        : "Two face choices for the same photo",
    ),
  ),
  /** Photos always sent as character references. */
  pins: Schema.Array(Ordinal),
  targetLook: TargetLook,
  /**
   * The hard USD limit for the whole Run, in whole micro-dollars (at most 6
   * decimals; the ledger's unit), from $0.000001 to `MAX_BUDGET_USD`.
   */
  budgetUsd: Schema.Finite.check(
    Schema.makeFilter((usd: number) =>
      isWholeMicros(usd) && toMicros(usd) >= 1 && usd <= MAX_BUDGET_USD
        ? true
        : `budgetUsd must be a whole number of micro-dollars (at most 6 decimals), from $0.000001 to $${MAX_BUDGET_USD}`,
    ),
  ),
  /** Candidates per Iteration in each Lane. */
  candidates: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CANDIDATES })),
  /** One or more Lanes, each driving one Image Model; a Lane's photos must be among the Run's. */
  lanes: Schema.Array(LaneRequest).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(
    ({ photos, lanes }: { photos: readonly string[]; lanes: readonly LaneRequest[] }) => {
      const outside = lanes
        .flatMap(({ photos: own = [] }) => own)
        .find((photo) => photo > photos.length);
      return outside === undefined
        ? true
        : `A Lane lists photo ${outside}, but the Run has ${photos.length} Reference Photo${photos.length === 1 ? "" : "s"}`;
    },
  ),
);
export type RunRequest = typeof RunRequest.Type;

/**
 * Why a Lane stopped: `budget-exhausted` when a billable call didn't fit the
 * Budget, `iteration-limit` when it ran its Iterations (one, in M0).
 */
export const LaneStopReason = Schema.Literals(["budget-exhausted", "iteration-limit"]);
export type LaneStopReason = typeof LaneStopReason.Type;
