import { Schema } from "effect";
import type { CandidateOutcome } from "./likeness";
import type { Judgement } from "./rubric";

/**
 * Why a Lane stopped. When several rules hold after the same Iteration, the
 * first in this order wins (`laneStopReason` follows it):
 * 1. `cancelled`: the operator cancelled the Run.
 * 2. `optimizer-failed`: the vendor turned an Optimizer call away for good
 *    (HTTP 401, 402, 403 or 404, or Google's 400 for a bad key); the Lane
 *    stops at once, without a next Prompt.
 * 3. `judge-failed`: the vendor turned a Judge call away for good; the Lane
 *    stops once the Iteration's calls have settled.
 * 4. `target-score`: the Lane's best Candidate reached the target score.
 * 5. `budget-exhausted`: a billable call (Image Model, Judge or Optimizer)
 *    didn't fit the Budget, so it wasn't made.
 * 6. `repeated-failures`: two Iterations in a row whose Candidates were all
 *    Refused or Failed.
 * 7. `patience`: the patience Iterations in a row without the best score
 *    rising by the minimum improvement.
 * 8. `iteration-limit`: the Lane ran its maximum Iterations.
 * The operator's stop comes first; then a role whose every further call would
 * be turned away; then success, so a Lane that reached its target says so
 * even if a call of the same Iteration didn't fit; then the Budget; then the
 * failure signals; the Iteration cap last.
 */
export const LaneStopReason = Schema.Literals([
  "cancelled",
  "optimizer-failed",
  "judge-failed",
  "target-score",
  "budget-exhausted",
  "repeated-failures",
  "patience",
  "iteration-limit",
]);
export type LaneStopReason = typeof LaneStopReason.Type;

/** The stop reasons that come with the vendor's reason, stored as the Lane's stop detail. */
export const LANE_STOPS_WITH_DETAIL = [
  "optimizer-failed",
  "judge-failed",
] as const satisfies readonly LaneStopReason[];

/** The most Iterations a Run may allow a Lane; the Budget is the practical limit. */
export const MAX_ITERATIONS = 50;

/** Iteration counts a Run may set: 1 to `MAX_ITERATIONS`. */
const IterationCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ITERATIONS }));

/**
 * When a Lane stops, set per Run (issue #1 defaults in `DEFAULT_STOP_RULES`).
 * Scores are weighted totals on 0–10.
 */
export const StopRules = Schema.Struct({
  /** A Lane whose best Candidate scores at least this stops with `target-score`. */
  targetScore: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  /**
   * This many Iterations in a row without an improvement stop the Lane with
   * `patience`; above `maxIterations` it can never fire, which turns it off.
   */
  patience: IterationCount,
  /** The least rise of the best score that counts as an improvement; above 0, at most 10. */
  minImprovement: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10)),
  /** A Lane that ran this many Iterations stops with `iteration-limit`. */
  maxIterations: IterationCount,
});
export type StopRules = typeof StopRules.Type;

/** Issue #1's stopping rules: target 8.5, patience 3 Iterations rising by 0.2, at most 8 Iterations. */
export const DEFAULT_STOP_RULES: StopRules = {
  targetScore: 8.5,
  patience: 3,
  minImprovement: 0.2,
  maxIterations: 8,
};

/** A Candidate as the stopping rules and the Lane's best see it. */
export interface RankedCandidate {
  readonly outcome: CandidateOutcome | null;
  readonly judgement: Judgement | null;
}

/**
 * The Lane's best Candidate, from its Candidates in order (by Iteration, then
 * index): the highest score (weighted total; only a judged Candidate has
 * one), the first among equal scores; null when no Candidate was judged.
 */
export function bestCandidate<C extends RankedCandidate>(
  candidates: readonly C[],
): { readonly candidate: C; readonly score: number } | null {
  let best: { candidate: C; score: number } | null = null;
  for (const candidate of candidates) {
    const { judgement } = candidate;
    if (judgement?._tag !== "Judged") continue;
    const score = judgement.weightedTotal;
    if (best === null || score > best.score) best = { candidate, score };
  }
  return best;
}

/** One finished Iteration as the stopping rules see it. */
export interface IterationResult {
  /** Its best score; null when none of its Candidates was judged. */
  readonly best: number | null;
  /**
   * Every Candidate was Refused or Failed (a Gated Candidate is an image, so
   * it doesn't count as a failure); false for an Iteration without Candidates.
   */
  readonly allFailed: boolean;
  /** A stored Candidate shows that one of its calls didn't fit the Budget (`showsBudgetExhausted`). */
  readonly budgetExhausted: boolean;
  /**
   * The vendor's reason when a stored judgement shows a Judge call turned
   * away for good (`JudgeFailed` with cause `non-recoverable`); else null.
   */
  readonly judgeRejected: string | null;
}

/**
 * Whether a Candidate's stored outcome or judgement shows that one of its
 * calls didn't fit the Budget: Failed with `budgetExhausted` (its image call
 * or a retry), or `JudgeFailed` with cause `budget-exhausted`.
 */
export function showsBudgetExhausted({
  outcome = null,
  judgement = null,
}: Partial<RankedCandidate>): boolean {
  return (
    (outcome?._tag === "Failed" && outcome.budgetExhausted === true) ||
    (judgement?._tag === "JudgeFailed" && judgement.cause === "budget-exhausted")
  );
}

/** An Iteration's Candidates as an `IterationResult`. */
export function iterationResult(candidates: readonly RankedCandidate[]): IterationResult {
  const rejected = candidates.find(
    ({ judgement }) => judgement?._tag === "JudgeFailed" && judgement.cause === "non-recoverable",
  )?.judgement;
  return {
    best: bestCandidate(candidates)?.score ?? null,
    allFailed:
      candidates.length > 0 &&
      candidates.every(({ outcome }) => outcome?._tag === "Refused" || outcome?._tag === "Failed"),
    budgetExhausted: candidates.some(showsBudgetExhausted),
    judgeRejected: rejected?._tag === "JudgeFailed" ? rejected.reason : null,
  };
}

/** Scores are compared at 9 decimals (weighted totals are rounded so), so 8.5 − 8.3 is 0.2. */
const SCORE_DECIMALS = 9;

/**
 * Whether `next` improves on `best` by at least `minImprovement`; exactly
 * the minimum counts. Any score improves on no score at all.
 */
export function isImprovement(best: number | null, next: number, minImprovement: number): boolean {
  return best === null || Number((next - best).toFixed(SCORE_DECIMALS)) >= minImprovement;
}

/**
 * How many Iterations in a row, up to the last, haven't improved the best
 * score by the minimum. The reference is the best score at the last
 * improvement: rises below the minimum don't move it, so small rises that
 * add up to the minimum count as one improvement. An Iteration with no score
 * isn't an improvement.
 */
export function iterationsWithoutImprovement(
  history: readonly IterationResult[],
  minImprovement: number,
): number {
  let reference: number | null = null;
  let without = 0;
  for (const { best } of history) {
    if (best !== null && isImprovement(reference, best, minImprovement)) {
      reference = best;
      without = 0;
    } else {
      without++;
    }
  }
  return without;
}

/**
 * Why the Lane stops after its last Iteration in `history`, or null to run
 * another: of the rules that hold, the first in `LaneStopReason`'s order.
 * The Budget ran out when `budgetExhausted` says so (a call of the last
 * Iteration didn't fit, e.g. one that left no Candidate) or the last
 * Iteration's stored Candidates show it; the Judge failed when they show a
 * Judge call turned away for good. Cancellation and `optimizer-failed` never
 * reach here: a cancelled Lane stops where it is, and the Optimizer is called
 * only once no rule holds, its rejection stopping the Lane at once.
 */
export function laneStopReason(
  history: readonly IterationResult[],
  rules: StopRules,
  budgetExhausted: boolean,
): LaneStopReason | null {
  const holds: { readonly [R in LaneStopReason]: () => boolean } = {
    cancelled: () => false,
    "optimizer-failed": () => false,
    "judge-failed": () => (history.at(-1)?.judgeRejected ?? null) !== null,
    "target-score": () => history.some(({ best }) => best !== null && best >= rules.targetScore),
    "budget-exhausted": () => budgetExhausted || history.at(-1)?.budgetExhausted === true,
    "repeated-failures": () =>
      history.length >= 2 && history.slice(-2).every(({ allFailed }) => allFailed),
    patience: () => iterationsWithoutImprovement(history, rules.minImprovement) >= rules.patience,
    "iteration-limit": () => history.length >= rules.maxIterations,
  };
  return LaneStopReason.literals.find((reason) => holds[reason]()) ?? null;
}
