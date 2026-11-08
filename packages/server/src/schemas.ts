import { Effort, LaneStopReason } from "@iconograph/domain";
import { Schema } from "effect";

/**
 * Step inputs and outputs of the Run workflow. Between steps they carry ids,
 * Iteration numbers and stop reasons, never image data or embeddings, so
 * Mastra's snapshots stay small (the workflow input is the Run request);
 * everything else is in the Run tables and the image store.
 */

/**
 * A Lane between its Iterations, and between the phases of one: the
 * Iteration it is on, and `stopReason` once it must stop (generating or
 * judging sets `budget-exhausted` when a call didn't fit; the optimize phase
 * decides every stop; a re-executed Iteration of a Lane whose stop is stored
 * returns that stop).
 */
export const LaneState = Schema.Struct({
  runId: Schema.String,
  lane: Schema.Int,
  model: Schema.String,
  iteration: Schema.Int,
  stopReason: Schema.NullOr(LaneStopReason),
});
export type LaneState = typeof LaneState.Type;

/**
 * A stopped Lane: why, with the vendor's reason (`stopDetail`) when the
 * Optimizer or the Judge was turned away for good, else null; how many
 * Iterations it began (each has its Prompt stored); and its best Candidate
 * (null when none was judged): its Iteration (from 1), its index within the
 * Iteration (from 0) and its weighted total.
 */
export const LaneResult = Schema.Struct({
  runId: Schema.String,
  lane: Schema.Int,
  stopReason: LaneStopReason,
  stopDetail: Schema.NullOr(Schema.NonEmptyString),
  iterations: Schema.Int,
  best: Schema.NullOr(
    Schema.Struct({ iteration: Schema.Int, candidate: Schema.Int, score: Schema.Finite }),
  ),
});
export type LaneResult = typeof LaneResult.Type;

export const RunResult = Schema.Struct({
  runId: Schema.String,
  lanes: Schema.Array(LaneResult),
});
export type RunResult = typeof RunResult.Type;

/**
 * Printed before any Candidate is generated: at most what the Run can cost if
 * every Lane runs all `maxIterations` Iterations, each call at its first-call
 * estimate (retries, and calls that cost more than estimated, can exceed it),
 * Iterations after the first at the longest Prompt. `estimatedUsd` totals the
 * Lanes' Image Model calls, the Judge's calls and the Optimizer's calls.
 */
export const EstimateEvent = Schema.Struct({
  event: Schema.Literal("estimate"),
  runId: Schema.String,
  budgetUsd: Schema.Finite,
  maxIterations: Schema.Int,
  estimatedUsd: Schema.Finite,
  /**
   * Every Lane's Candidates of every Iteration; `perCallUsd` is one call of
   * Iteration 1 (with the Lane's Prompt), later Iterations' calls are quoted
   * at the longest Prompt.
   */
  lanes: Schema.Array(
    Schema.Struct({
      lane: Schema.Int,
      model: Schema.String,
      candidates: Schema.Int,
      perCallUsd: Schema.Finite,
      estimatedUsd: Schema.Finite,
    }),
  ),
  /** Judging every Candidate of every Lane and Iteration. */
  judge: Schema.Struct({
    model: Schema.String,
    effort: Effort,
    calls: Schema.Int,
    perCallUsd: Schema.Finite,
    estimatedUsd: Schema.Finite,
  }),
  /**
   * One Optimizer call between each two Iterations of each Lane, each quoted
   * at the largest request the Run allows, plus a margin (`quoteOptimizerCall`);
   * none for a Run of one Iteration.
   */
  optimizer: Schema.Struct({
    model: Schema.String,
    effort: Effort,
    calls: Schema.Int,
    perCallUsd: Schema.Finite,
    estimatedUsd: Schema.Finite,
  }),
});
export type EstimateEvent = typeof EstimateEvent.Type;
