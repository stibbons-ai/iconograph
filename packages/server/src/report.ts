import { type CallRecord, candidateKeyOf, imagePath, RunStore } from "@iconograph/adapters";
import {
  type CandidateOutcome,
  type Judgement,
  judgeVendor,
  type PriceQuote,
  remainingMicros,
  sameVendorLanes,
  toUsd,
} from "@iconograph/domain";
import { Effect } from "effect";
import { ITERATION, RunConfig } from "./run-steps";

/** Estimated and actual USD of some calls; `unknownCostCalls` count at their estimate in the Budget. */
function costs(calls: readonly CallRecord[]) {
  const estimated = calls.reduce((sum, call) => sum + call.estimateMicros, 0);
  const actual = calls.reduce((sum, call) => sum + (call.actualMicros ?? 0), 0);
  return {
    estimatedUsd: toUsd(estimated),
    actualUsd: toUsd(actual),
    unknownCostCalls: calls.filter((call) => call.actualMicros === null).length,
  };
}

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
  ...costs(calls),
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
          message: `The Judge ${judgeModel} comes from ${judgeVendor(judgeModel)}, as the Image Model of Lane ${lanes.join(", ")}; it may favour that vendor's images`,
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
 * per Candidate its Outcome, Likeness, reason, stored image and generation
 * costs, its judgement and Judge costs; per Lane its initial Prompt and stop
 * reason; the Judge; totals against the Budget; the Run's and the photo
 * report's warnings.
 * Totals come from every billable call of the Run (the ledger the Budget
 * checks), including calls whose Candidate was never saved because the Run
 * failed; those are listed in `unattributedCalls`.
 */
export const runReport = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { dataDirectory } = yield* RunConfig;
    const run = yield* store.loadRun(runId);
    const lanes = yield* store.loadLanes(runId);
    // The Prompt stored for Iteration 1 (what any of its calls sent; a Run whose Budget fits no
    // call stores it but sends nothing); null when the Run died before storing it.
    const prompts = yield* Effect.forEach(lanes, ({ lane }) =>
      store.loadPrompt({ runId, lane, iteration: ITERATION }).pipe(
        Effect.catchIf(
          (error) => error.notFound === true,
          () => Effect.succeed(null),
        ),
      ),
    );
    const judge = yield* store.loadJudge(runId);
    const { candidates, calls: ledger } = yield* store.loadRecords(runId);
    const saved = new Set(candidates.map(candidateKeyOf));
    const unattributed = ledger.filter((call) => !saved.has(candidateKeyOf(call)));
    return {
      runId,
      createdAt: run.createdAt.toISOString(),
      targetLook: run.request.targetLook,
      candidatesPerIteration: run.request.candidates,
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
      lanes: lanes.map((lane, index) => {
        const own = candidates.filter((candidate) => candidate.lane === lane.lane);
        return {
          lane: lane.lane,
          model: lane.model,
          stopReason: lane.stopReason,
          initialPrompt: prompts[index] ?? null,
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
          ...costs(ledger.filter((call) => call.lane === lane.lane)),
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
        ...costs(ledger),
        remainingUsd: toUsd(remainingMicros(run.budgetMicros, ledger)),
      },
    };
  });
