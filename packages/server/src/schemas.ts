import { JudgeEffort, LaneStopReason } from "@iconograph/domain";
import { Schema } from "effect";

/**
 * Step inputs and outputs of the Run workflow. Between steps they carry ids
 * and stop reasons, never image data or embeddings, so Mastra's snapshots stay
 * small (the workflow input is the Run request); everything else is in the Run
 * tables and the image store.
 */
export const LaneInput = Schema.Struct({
  runId: Schema.String,
  lane: Schema.Int,
  model: Schema.String,
});
export type LaneInput = typeof LaneInput.Type;

/** After generating, and after scoring: `stopReason` is set when the Lane already has to stop. */
export const LaneGenerated = Schema.Struct({
  runId: Schema.String,
  lane: Schema.Int,
  stopReason: Schema.NullOr(LaneStopReason),
});
export type LaneGenerated = typeof LaneGenerated.Type;

export const LaneResult = Schema.Struct({
  runId: Schema.String,
  lane: Schema.Int,
  stopReason: LaneStopReason,
});
export type LaneResult = typeof LaneResult.Type;

export const RunResult = Schema.Struct({
  runId: Schema.String,
  lanes: Schema.Array(LaneResult),
});
export type RunResult = typeof RunResult.Type;
/** Printed before any Candidate is generated; `estimatedUsd` includes the Judge's calls. */
export const EstimateEvent = Schema.Struct({
  event: Schema.Literal("estimate"),
  runId: Schema.String,
  budgetUsd: Schema.Finite,
  /** Every Lane's Candidates at their first-call estimate (retries not included). */
  estimatedUsd: Schema.Finite,
  lanes: Schema.Array(
    Schema.Struct({
      lane: Schema.Int,
      model: Schema.String,
      candidates: Schema.Int,
      perCallUsd: Schema.Finite,
      estimatedUsd: Schema.Finite,
    }),
  ),
  /** Judging every Candidate of every Lane, at the first-call estimate. */
  judge: Schema.Struct({
    model: Schema.String,
    effort: JudgeEffort,
    calls: Schema.Int,
    perCallUsd: Schema.Finite,
    estimatedUsd: Schema.Finite,
  }),
});
export type EstimateEvent = typeof EstimateEvent.Type;
