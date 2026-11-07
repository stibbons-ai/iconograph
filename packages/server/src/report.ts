import {
  type CallRecord,
  candidateKeyOf,
  errorMessage,
  imagePath,
  RunStore,
  workflowsStore,
} from "@iconograph/adapters";
import {
  callCosts,
  type CandidateOutcome,
  type Judgement,
  llmVendor,
  type PriceQuote,
  remainingMicros,
  sameVendorLanes,
  toUsd,
} from "@iconograph/domain";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { Data, Effect } from "effect";
import { bestCandidateView, RunConfig } from "./run-steps";
import { RUN_WORKFLOW_ID } from "./workflow";

/** Reading Mastra's snapshot of the Run, for its report, failed. */
export class RunSnapshotError extends Data.TaggedError("RunSnapshotError")<{
  runId: string;
  message: string;
  cause: unknown;
}> {}

/** Whether Mastra stored the Run as cancelled. */
const workflowCancelled = (storage: MastraCompositeStore, runId: string) =>
  Effect.tryPromise({
    try: async () =>
      (await workflowsStore(storage)).loadWorkflowSnapshot({
        workflowName: RUN_WORKFLOW_ID,
        runId,
      }),
    catch: (cause) =>
      new RunSnapshotError({
        runId,
        message: `Reading the workflow snapshot of Run ${runId} failed: ${errorMessage(cause)}`,
        cause,
      }),
  }).pipe(Effect.map((snapshot) => snapshot?.status === "canceled"));

/** An Outcome variant as report fields: its tag as `outcome`, then its details. */
type OutcomeFields<O> = O extends { _tag: infer Tag } ? { outcome: Tag } & Omit<O, "_tag"> : never;

function outcomeFields(
  outcome: CandidateOutcome | null,
): OutcomeFields<CandidateOutcome> | { outcome: null } {
  if (outcome === null) return { outcome: null };
  const { _tag, ...details } = outcome;
  // TypeScript can't relate a destructured tag back to its variant; the shape is the same.
  return { outcome: _tag, ...details } as OutcomeFields<CandidateOutcome>;
}

/** A call as shown in the report; `settled: false` means no result was recorded. */
const callView = (call: CallRecord) => ({
  purpose: call.purpose,
  attempt: call.attempt,
  settled: call.settled,
  result: call.result,
  ...(call.reason !== null && { reason: call.reason }),
  estimatedUsd: toUsd(call.estimateMicros),
  actualUsd: call.actualMicros === null ? null : toUsd(call.actualMicros),
  usage: call.usage,
});

/** Calls and their costs, as shown for one purpose of a Candidate. */
const callsView = (calls: readonly CallRecord[]) => ({
  ...callCosts(calls),
  calls: calls.map(callView),
});

/**
 * A judgement as report fields: `judged` with Resemblance (never blended
 * with Likeness), every criterion's score, the weighted total, Disputed, the
 * issues and suggested Prompt fixes; or `judge-failed` with why.
 */
function judgementView(judgement: Judgement | null) {
  if (judgement === null) return null;
  if (judgement._tag === "JudgeFailed") {
    const { _tag, ...failed } = judgement;
    return { status: "judge-failed" as const, ...failed };
  }
  const { _tag, scores, ...judged } = judgement;
  return { status: "judged" as const, resemblance: scores.resemblance, scores, ...judged };
}

/**
 * The Run's coded warnings; branch on `code`, never the message.
 * `judge-same-vendor`: the Judge comes from the vendor of the listed Lanes'
 * Image Model, and may favour its images.
 */
function runWarnings(judgeModel: string, laneModels: readonly string[]) {
  const lanes = sameVendorLanes(judgeModel, laneModels);
  return lanes.length === 0
    ? []
    : [
        {
          code: "judge-same-vendor" as const,
          message: `The Judge ${judgeModel} comes from ${llmVendor(judgeModel)}, as the Image Model of Lane ${lanes.join(", ")}; it may favour that vendor's images`,
          lanes,
        },
      ];
}

/**
 * Where a Lane's price came from and how old it was when the Run started,
 * including whether the LiteLLM data was `stale`.
 */
const priceView = ({ _tag, ...age }: PriceQuote["source"]) => ({ source: _tag, ...age });

/**
 * Everything the operator needs about a Run, read back from the Run tables:
 * per Candidate its Iteration (from 1), index (from 0), Outcome, Likeness,
 * reason, stored image and generation costs, its judgement and Judge costs;
 * per Lane `resample: true` for a Resample Lane, its stop reason (with
 * `stopDetail`, the vendor's reason, when the Optimizer or the Judge was
 * turned away for good), how many Iterations it
 * began (each has its Prompt stored; the last may have made no call, if the
 * Run was cancelled or its first calls didn't fit the Budget), its best
 * Candidate, and its Prompt history (each Iteration's Prompt, where it came
 * from, and the cost of that Iteration's Optimizer calls, which wrote the
 * next Iteration's Prompt); the Judge, the Optimizer and the stopping rules;
 * totals against the Budget; the Run's and the photo report's warnings.
 * Totals come from every billable call of the Run (the ledger the Budget
 * checks), including calls whose Candidate was never saved (the Run failed or
 * was cancelled mid-call); those are listed in `unattributedCalls`.
 * A Run Mastra stored as cancelled (its snapshot in `storage`) shows a Lane
 * without a stop reason as `cancelled`: recording it may have been cut off
 * (the process stopped while the Run's steps unwound).
 */
export const runReport = (storage: MastraCompositeStore, runId: string) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { dataDirectory } = yield* RunConfig;
    const run = yield* store.loadRun(runId);
    const cancelled = yield* workflowCancelled(storage, runId);
    const lanes = yield* store.loadLanes(runId);
    // Each Iteration's stored Prompt (what any of its calls sent; a Run whose Budget fits no
    // call stores the first but sends nothing). A Lane that died before storing one has none.
    const iterations = yield* store.loadIterations(runId);
    const judge = yield* store.loadJudge(runId);
    const optimizerPrice = yield* store.loadOptimizer(runId);
    const { candidates, calls: ledger } = yield* store.loadRecords(runId);
    const saved = new Set(candidates.map(candidateKeyOf));
    // An Optimizer call is keyed by its Iteration, which is stored before any of its calls.
    const unattributed = ledger.filter(
      (call) => call.candidate !== null && !saved.has(candidateKeyOf(call)),
    );
    return {
      runId,
      createdAt: run.createdAt.toISOString(),
      targetLook: run.request.targetLook,
      candidatesPerIteration: run.request.candidates,
      stopRules: run.request.stopRules,
      warnings: runWarnings(
        run.request.judge.model,
        lanes.map(({ model }) => model),
      ),
      referencePhotos: {
        photos: run.photoReport.photos.map((photo) => ({
          photo: photo.photo,
          path: photo.path,
          verdict: photo.verdict,
          ...("similarity" in photo && {
            similarity: photo.similarity,
            similarityTo: photo.similarityTo,
          }),
        })),
        warnings: run.photoReport.warnings,
      },
      identity: {
        faceModel: run.identity.faceModel,
        gate: run.identity.gate,
        ceiling: run.identity.ceiling,
      },
      judge: {
        ...run.request.judge,
        ...(judge && {
          rubricVersion: judge.rubricVersion,
          referencePhotos: judge.referencePhotos,
          price: priceView(judge.price.source),
        }),
      },
      optimizer: {
        ...run.request.optimizer,
        ...(optimizerPrice && { price: priceView(optimizerPrice.source) }),
      },
      lanes: lanes.map((lane) => {
        const own = candidates.filter((candidate) => candidate.lane === lane.lane);
        const prompts = iterations.filter((iteration) => iteration.lane === lane.lane);
        return {
          lane: lane.lane,
          model: lane.model,
          ...(run.request.lanes[lane.lane]?.resample && { resample: true as const }),
          // A Run Mastra stored as cancelled whose cancel wasn't recorded yet.
          stopReason: lane.stopReason ?? (cancelled ? "cancelled" : null),
          ...(lane.stopDetail !== null && { stopDetail: lane.stopDetail }),
          iterations: prompts.length,
          best: bestCandidateView(own),
          prompts: prompts.map((prompt) => ({
            iteration: prompt.iteration,
            prompt: prompt.prompt,
            source: prompt.source,
            ...(prompt.source === "kept" && { reason: prompt.reason }),
            optimizerCost: callsView(
              ledger.filter(
                (call) =>
                  call.purpose === "optimize" &&
                  call.lane === lane.lane &&
                  call.iteration === prompt.iteration,
              ),
            ),
          })),
          characterReferences: lane.characterReferences,
          price: priceView(lane.price.source),
          candidates: own.map(({ iteration, candidate, outcome, image, judgement, calls }) => ({
            iteration,
            candidate,
            ...outcomeFields(outcome),
            image: image && {
              sha256: image.sha256,
              path: imagePath(dataDirectory, image.sha256, image.type),
            },
            ...callsView(calls.filter(({ purpose }) => purpose === "generate")),
            judgement: judgementView(judgement),
            judgeCost: callsView(calls.filter(({ purpose }) => purpose === "judge")),
          })),
          ...callCosts(ledger.filter((call) => call.lane === lane.lane)),
        };
      }),
      unattributedCalls: unattributed.map((call) => ({
        lane: call.lane,
        iteration: call.iteration,
        candidate: call.candidate,
        ...callView(call),
      })),
      totals: {
        budgetUsd: toUsd(run.budgetMicros),
        ...callCosts(ledger),
        remainingUsd: toUsd(remainingMicros(run.budgetMicros, ledger)),
      },
    };
  });
