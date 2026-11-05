import type { CallCosts, JudgeFailure, LaneStopReason, PriceQuote } from "@iconograph/domain";

/*
 * What the eval harness records per Arm Run: each Candidate's loop scores, as
 * its Run stored them, beside the evaluation's own held-out scores.
 */

/** The strategies compared at equal Budget (GLOSSARY "Arm"). */
export const ARMS = ["optimizer", "resample"] as const;
export type Arm = (typeof ARMS)[number];

/**
 * A Candidate image's held-out FaceNet score: its best face's similarity to
 * the Subject's held-out anchor; `no-face` and `unreadable` (bytes that aren't
 * a usable image) are counted, never averaged in.
 */
export type HeldOutScore =
  | { readonly status: "scored"; readonly similarity: number; readonly pass: boolean }
  | { readonly status: "no-face" }
  | { readonly status: "unreadable"; readonly reason: string };

/**
 * A Candidate image's second-Judge score: the Rubric's weighted total over the
 * Judge's criteria alone (Likeness, the loop's face model, is left out), or
 * why there is none: the judging failed (with its cause), the image isn't
 * usable (as the held-out decode found), or it was `skipped` because the
 * second Judge's vendor had turned a call away for good. None is averaged in.
 */
export type EvalJudgeScore =
  | { readonly status: "judged"; readonly score: number }
  | { readonly status: "judge-failed"; readonly cause: JudgeFailure; readonly reason: string }
  | { readonly status: "unreadable"; readonly reason: string }
  | { readonly status: "skipped"; readonly reason: string };

export interface EvaluatedCandidate {
  readonly iteration: number;
  readonly candidate: number;
  /** The Candidate Outcome the Run stored (null: generated but never scored). */
  readonly outcome: string | null;
  /** The loop's own scores, when it has them: its Judge's weighted total and the SFace Likeness. */
  readonly loop: { readonly judgeTotal: number | null; readonly likeness: number | null };
  /**
   * Null exactly when the Candidate has no image (Refused, or Failed without
   * one); then `evalJudge` is null too. A fault while scoring an image never
   * leaves a Candidate here: it aborts the evaluation.
   */
  readonly heldOut: HeldOutScore | null;
  readonly evalJudge: EvalJudgeScore | null;
}

/**
 * Where a price came from, as the Run report shows it: `source` (LiteLLM
 * data, the bundled snapshot or an override), its date and age, and whether
 * the LiteLLM data was stale or which commit the snapshot is.
 */
export interface PriceSourceView {
  readonly source: PriceQuote["source"]["_tag"];
  readonly asOf: string;
  readonly ageSeconds: number;
  readonly stale?: boolean;
  readonly commit?: string;
}

/** One Arm's Run for one Subject and Image Model, as evaluated. */
export interface ArmRun {
  readonly subject: string;
  readonly model: string;
  readonly arm: Arm;
  /** Null for a Run that failed before it was stored. */
  readonly runId: string | null;
  /**
   * The Run ended and every Candidate image was scored. False only for the
   * Run whose fault aborted the evaluation: it is listed with what it stored
   * and spent, unscored, and left out of the comparison.
   */
  readonly complete: boolean;
  readonly stopReason: LaneStopReason | null;
  /** The vendor's reason for `judge-failed` and `optimizer-failed`. */
  readonly stopDetail: string | null;
  readonly iterations: number;
  /** The Run's own spend, against its Budget; null when it couldn't be read back (unknown, not $0). */
  readonly armCost: CallCosts | null;
  /** The second Judge's spend on this Run's images, outside the Budget. */
  readonly evalCost: CallCosts;
  /** Where each role's price came from; null when unknown (not stored or not read back). */
  readonly prices: {
    readonly imageModel: PriceSourceView | null;
    readonly judge: PriceSourceView | null;
    readonly optimizer: PriceSourceView | null;
  };
  readonly candidates: readonly EvaluatedCandidate[];
}
