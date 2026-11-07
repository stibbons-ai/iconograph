import { describe, expect, test } from "bun:test";
import {
  bestCandidate,
  byCriterion,
  type CandidateOutcome,
  DEFAULT_STOP_RULES,
  DEFAULT_WEIGHTS,
  type IterationResult,
  iterationResult,
  isImprovement,
  iterationsWithoutImprovement,
  JUDGED_CRITERIA,
  type Judgement,
  laneStopReason,
  RUBRIC_V1,
  scoreVerdict,
} from "../src";

/** An Iteration whose best score is `best` (null: nothing judged). */
const scored = (best: number | null): IterationResult => ({
  best,
  allFailed: false,
  budgetExhausted: false,
  judgeRejected: null,
});
const failed: IterationResult = { ...scored(null), allFailed: true };
const rules = DEFAULT_STOP_RULES;

describe("improvement threshold", () => {
  test("a rise of exactly the minimum counts; anything below doesn't", () => {
    expect(isImprovement(7, 7.2, 0.2)).toBe(true);
    expect(isImprovement(7, 7.199999, 0.2)).toBe(false);
    expect(isImprovement(7, 7.5, 0.2)).toBe(true);
    expect(isImprovement(7, 7, 0.2)).toBe(false);
    expect(isImprovement(7, 6, 0.2)).toBe(false);
  });

  test("float subtraction can't hide a rise of the minimum: 8.3 → 8.5 is 0.2", () => {
    // 8.5 − 8.3 is 0.1999999999999993 in floating point.
    expect(8.5 - 8.3).toBeLessThan(0.2);
    expect(isImprovement(8.3, 8.5, 0.2)).toBe(true);
    expect(isImprovement(0.1, 0.3, 0.2)).toBe(true);
  });

  test("the first score improves on no score", () => {
    expect(isImprovement(null, 0, 0.2)).toBe(true);
  });
});

describe("patience counting", () => {
  const count = (bests: (number | null)[]) => iterationsWithoutImprovement(bests.map(scored), 0.2);

  test("the first scored Iteration is an improvement; every later one without a rise counts", () => {
    expect(count([5])).toBe(0);
    expect(count([5, 5.1])).toBe(1);
    expect(count([5, 5.1, 4, 5.19])).toBe(3);
  });

  test("an improvement resets the count", () => {
    expect(count([5, 5, 5, 5.2])).toBe(0);
    expect(count([5, 5, 5.2, 5.3])).toBe(1);
  });

  test("small rises that add up to the minimum count as an improvement", () => {
    // 5 → 5.1 → 5.2: each 0.1, but 5.2 is 0.2 above 5, the best at the last improvement.
    expect(count([5, 5.1, 5.2])).toBe(0);
  });

  test("Iterations without any score count, including before the first score", () => {
    expect(count([null, null])).toBe(2);
    expect(count([null, 5])).toBe(0);
    expect(count([5, null, null])).toBe(2);
  });
});

describe("laneStopReason", () => {
  test("the best reaching the target stops the Lane; exactly the target counts", () => {
    expect(laneStopReason([scored(8.5)], rules, false)).toBe("target-score");
    expect(laneStopReason([scored(8.499999999)], rules, false)).toBeNull();
    expect(laneStopReason([scored(9), scored(3)], rules, false)).toBe("target-score");
  });

  test("patience: 3 Iterations in a row without the best rising by 0.2", () => {
    expect(laneStopReason([scored(5), scored(5.1), scored(5.1)], rules, false)).toBeNull();
    expect(laneStopReason([scored(5), scored(5.1), scored(5.1), scored(5.19)], rules, false)).toBe(
      "patience",
    );
    expect(
      laneStopReason([scored(5), scored(5.1), scored(5.1), scored(5.2)], rules, false),
    ).toBeNull();
  });

  test("two fully Refused/Failed Iterations in a row stop the Lane; any other Iteration between resets", () => {
    expect(laneStopReason([failed], rules, false)).toBeNull();
    expect(laneStopReason([scored(5), failed, failed], rules, false)).toBe("repeated-failures");
    const patient = { ...rules, patience: 5 };
    expect(laneStopReason([failed, scored(null), failed], patient, false)).toBeNull();
  });

  test("the Iteration limit stops the Lane after its last Iteration", () => {
    const rising = (n: number) => Array.from({ length: n }, (_, index) => scored(index));
    expect(laneStopReason(rising(7), rules, false)).toBeNull();
    expect(laneStopReason(rising(8), rules, false)).toBe("iteration-limit");
    expect(laneStopReason(rising(1), { ...rules, maxIterations: 1 }, false)).toBe(
      "iteration-limit",
    );
  });

  test("precedence follows LaneStopReason's order: target, budget, repeated failures, patience, the limit", () => {
    const limitOne = { ...rules, maxIterations: 1 };
    // A Lane that reached its target says so, even when a call of the Iteration didn't fit.
    expect(laneStopReason([scored(9)], limitOne, true)).toBe("target-score");
    expect(laneStopReason([scored(5)], limitOne, true)).toBe("budget-exhausted");
    expect(laneStopReason([scored(9)], limitOne, false)).toBe("target-score");
    // Target and patience fire together: 8.4, then three Iterations below 8.6, the last 8.5.
    expect(
      laneStopReason([scored(8.4), scored(8.3), scored(8.35), scored(8.5)], rules, false),
    ).toBe("target-score");
    // Failures and patience fire together: the third and fourth Iterations failed after 5.
    const stuck = [scored(5), scored(5), failed, failed];
    expect(laneStopReason(stuck, { ...rules, maxIterations: 4 }, true)).toBe("budget-exhausted");
    expect(laneStopReason(stuck, { ...rules, maxIterations: 4 }, false)).toBe("repeated-failures");
    expect(
      laneStopReason(
        [scored(5), scored(5), scored(5), scored(5)],
        { ...rules, maxIterations: 4 },
        false,
      ),
    ).toBe("patience");
  });

  test("the last Iteration's stored Candidates showing a call that didn't fit stop the Lane", () => {
    const ranOut = { ...scored(5), budgetExhausted: true };
    expect(laneStopReason([ranOut], rules, false)).toBe("budget-exhausted");
    // Only the last Iteration counts: an earlier one's shortage was already acted on.
    expect(laneStopReason([ranOut, scored(6)], rules, false)).toBeNull();
  });

  test("a Judge turned away for good in the last Iteration stops the Lane before every other rule", () => {
    const limitOne = { ...rules, maxIterations: 1 };
    const rejected = (best: number | null) => ({
      ...scored(best),
      judgeRejected: "Judge HTTP 401",
    });
    // It outranks a reached target, a call that didn't fit and the Iteration limit.
    const judgeFailed = { reason: "judge-failed" as const, detail: "Judge HTTP 401" };
    expect(laneStopReason([rejected(9)], limitOne, true)).toEqual(judgeFailed);
    expect(laneStopReason([scored(5), rejected(null)], rules, false)).toEqual(judgeFailed);
    // Only the last Iteration counts.
    expect(laneStopReason([rejected(5), scored(6)], rules, false)).toBeNull();
  });

  test("patience above the Iteration limit never fires, which turns it off", () => {
    const flat = Array.from({ length: 8 }, () => scored(5));
    expect(laneStopReason(flat, { ...rules, patience: 9 }, false)).toBe("iteration-limit");
  });
});

describe("an Iteration's stored evidence for the stopping rules", () => {
  const scoredOutcome: CandidateOutcome = { _tag: "Scored", similarity: 0.6, likeness: 5 };
  test("the Budget ran out: a Failed Candidate whose retry didn't fit, or a Judge call that didn't fit", () => {
    const retry = {
      outcome: { _tag: "Failed", reason: "x", budgetExhausted: true } as const,
      judgement: null,
    };
    const notJudged = {
      outcome: scoredOutcome,
      judgement: {
        _tag: "JudgeFailed",
        rubricVersion: "rubric-v1",
        cause: "budget-exhausted",
        reason: "x",
      } as const,
    };
    const failedOtherwise = {
      outcome: { _tag: "Failed", reason: "x" } as const,
      judgement: null,
    };
    expect(iterationResult([retry]).budgetExhausted).toBe(true);
    expect(iterationResult([notJudged]).budgetExhausted).toBe(true);
    expect(iterationResult([failedOtherwise]).budgetExhausted).toBe(false);
  });

  test("a Judge call turned away for good shows in the Iteration, with the vendor's reason", () => {
    const judgeFailure = (cause: "non-recoverable" | "failed") => ({
      outcome: scoredOutcome,
      judgement: {
        _tag: "JudgeFailed",
        rubricVersion: "rubric-v1",
        cause,
        reason: "Judge HTTP 401: invalid x-api-key",
      } as const,
    });
    expect(
      iterationResult([judgeFailure("failed"), judgeFailure("non-recoverable")]),
    ).toMatchObject({ judgeRejected: "Judge HTTP 401: invalid x-api-key", budgetExhausted: false });
    expect(iterationResult([judgeFailure("failed")]).judgeRejected).toBeNull();
  });
});

const judged = (level: 1 | 2 | 3 | 4 | 5, likeness = 5): Judgement =>
  scoreVerdict(
    { levels: byCriterion(JUDGED_CRITERIA, () => level), issues: [], promptFixes: [] },
    likeness,
    DEFAULT_WEIGHTS,
    RUBRIC_V1,
  );
const scoredOutcome: CandidateOutcome = { _tag: "Scored", similarity: 0.6, likeness: 5 };

describe("an Iteration's Candidates", () => {
  test("its best is the highest weighted total among judged Candidates", () => {
    const candidates = [
      { outcome: scoredOutcome, judgement: judged(3) },
      { outcome: scoredOutcome, judgement: judged(5) },
      {
        outcome: scoredOutcome,
        judgement: {
          _tag: "JudgeFailed",
          rubricVersion: "rubric-v1",
          cause: "failed",
          reason: "x",
        },
      },
    ] satisfies { outcome: CandidateOutcome; judgement: Judgement }[];
    const result = iterationResult(candidates);
    expect(result.best).toBe((judged(5) as Extract<Judgement, { _tag: "Judged" }>).weightedTotal);
    expect(result.allFailed).toBe(false);
  });

  test("all Refused or Failed is a failed Iteration; a Gated Candidate is not a failure", () => {
    const refused = { outcome: { _tag: "Refused", reason: "x" } as const, judgement: null };
    const fail = { outcome: { _tag: "Failed", reason: "x" } as const, judgement: null };
    const gated = {
      outcome: { _tag: "Gated", reason: "no-face", similarity: null } as const,
      judgement: null,
    };
    expect(iterationResult([refused, fail])).toMatchObject({ best: null, allFailed: true });
    expect(iterationResult([refused, gated])).toMatchObject({ best: null, allFailed: false });
    expect(iterationResult([])).toMatchObject({ best: null, allFailed: false });
  });

  test("the Lane's best Candidate is the first of the highest score", () => {
    const candidates = [
      { iteration: 1, candidate: 0, outcome: scoredOutcome, judgement: judged(4) },
      { iteration: 2, candidate: 1, outcome: scoredOutcome, judgement: judged(5) },
      { iteration: 3, candidate: 0, outcome: scoredOutcome, judgement: judged(5) },
      { iteration: 3, candidate: 1, outcome: null, judgement: null },
    ];
    expect(bestCandidate(candidates)?.candidate).toMatchObject({ iteration: 2, candidate: 1 });
    expect(bestCandidate(candidates.slice(3))).toBeNull();
  });
});
