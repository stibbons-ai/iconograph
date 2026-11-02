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

/** A number from 1, as photos and faces are numbered in the Reference Photo report. */
const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

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
  /** One Lane per Image Model. */
  lanes: Schema.Array(Schema.Struct({ model: Schema.String })).check(Schema.isMinLength(1)),
});
export type RunRequest = typeof RunRequest.Type;

/**
 * Why a Lane stopped: `budget-exhausted` when a billable call didn't fit the
 * Budget, `iteration-limit` when it ran its Iterations (one, in M0).
 */
export const LaneStopReason = Schema.Literals(["budget-exhausted", "iteration-limit"]);
export type LaneStopReason = typeof LaneStopReason.Type;
