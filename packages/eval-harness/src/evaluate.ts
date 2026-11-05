import {
  attachCleanupError,
  errorMessage,
  readForJudge,
  validateReferencePhotos,
  withCleanup,
} from "@iconograph/adapters";
import type { HeldOutFaceEmbedder } from "@iconograph/adapters/held-out";
import {
  type CallCosts,
  type Effort,
  type Embedding,
  type EncodedImage,
  type FaceEmbedder,
  type FaceModelError,
  ImageModels,
  type Judge,
  type JudgeConfig,
  Judges,
  LANE_STOPS_WITH_DETAIL,
  type LaneStopReason,
  MAX_ITERATIONS,
  type OptimizerConfig,
  Optimizers,
  type RetryPolicy,
  RunRequest,
  type RubricWeights,
  type StopRules,
  selectJudgeReferences,
} from "@iconograph/domain";
import {
  createRunApplication,
  RunFailedError,
  type RunApplicationOptions,
  type RunWarning,
  type VendorsResource,
} from "@iconograph/server";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  ARMS,
  type Arm,
  type ArmRun,
  type EvalJudgeScore,
  type EvaluatedCandidate,
  type PriceSourceView,
} from "./arms";
import type { OutputLayout } from "./folders";
import {
  type EvalLedger,
  evalLedger,
  heldOutReferences,
  judgeImage,
  judgeOnlyWeights,
  scoreHeldOutImage,
} from "./scoring";
import type { Subject } from "./subjects";

/** What every Arm's Runs share: the Budget, Candidates, Judge, Optimizer and stopping rules. */
export interface EvalSettings {
  /** Image Model ids; every Subject gets one Run per Arm on each. */
  readonly models: readonly string[];
  /** Each Run's Budget: every Arm of a Subject and Image Model gets the same. */
  readonly budgetUsd: number;
  readonly candidates: number;
  readonly judge: JudgeConfig;
  readonly optimizer: OptimizerConfig;
  /** The Optimizer Arm's stopping rules; each Arm's are `armStopRules`. */
  readonly stopRules: StopRules;
  /** The second Judge, from another vendor than `judge`. */
  readonly evalJudge: { readonly model: string; readonly effort: Effort };
}

/** A warning of the evaluation, for stderr and the report; branch on `code`, never the message. */
export interface EvalWarning {
  readonly code:
    | "eval-judge-same-vendor"
    | "eval-judge-rejected"
    | "price-refresh-failed"
    | "run-warning"
    | "scratch-cleanup-failed";
  readonly message: string;
  readonly [detail: string]: unknown;
}

export interface EvalEnvironment {
  readonly vendors: VendorsResource;
  readonly faceEmbedder: Layer.Layer<FaceEmbedder, FaceModelError>;
  readonly heldOutEmbedder: Layer.Layer<HeldOutFaceEmbedder, FaceModelError>;
  /** Where the Runs go: their database and image store in the output folder. */
  readonly output: Pick<OutputLayout, "database" | "dataDirectory">;
  /**
   * A scratch folder of the free checks: validating the Subjects' photos
   * stores stripped copies, and nothing is written to the output folder
   * before `onReady`.
   */
  readonly scratch: string;
  readonly retryPolicy?: RetryPolicy;
  /** Test seam: wraps the Run tables' client (`RunApplicationOptions.wrapRunStoreClient`). */
  readonly wrapRunStoreClient?: RunApplicationOptions["wrapRunStoreClient"];
  /** Progress and the Runs' estimates, for stderr. */
  readonly progress: (event: object) => void;
  readonly warn: (warning: EvalWarning) => void;
  /**
   * Once every check that costs nothing has passed, just before the first
   * Run (and the first write to `output`): from here on, calls are billed.
   */
  readonly onReady: () => Promise<void>;
  /** Each Arm Run once it is evaluated (or has aborted the evaluation), before the next starts. */
  readonly onRun: (run: ArmRun) => Promise<void>;
}

/**
 * The evaluation stopped before its last Run; the message says why. Errors
 * that came after (handing the Run on, closing) are attached to it, never
 * in its place.
 */
export class EvalAborted extends Error {
  override name = "EvalAborted";
}

/** What a stored Run's report holds that the evaluation reads. */
interface StoredRunReport {
  readonly targetLook: RunRequest["targetLook"];
  readonly judge: { readonly price?: PriceSourceView };
  readonly optimizer: { readonly price?: PriceSourceView };
  readonly lanes: readonly {
    readonly stopReason: LaneStopReason | null;
    readonly stopDetail?: string;
    readonly iterations: number;
    readonly price: PriceSourceView;
    readonly candidates: readonly {
      readonly iteration: number;
      readonly candidate: number;
      readonly outcome: string | null;
      readonly likeness?: number;
      readonly image: { readonly path: string } | null;
      readonly judgement:
        | { readonly status: "judged"; readonly weightedTotal: number }
        | { readonly status: "judge-failed" }
        | null;
    }[];
  }[];
  readonly totals: CallCosts;
}

const decodeRequest = Schema.decodeUnknownSync(RunRequest);

/**
 * Each Arm's stopping rules. The Resample Arm runs with patience off (set
 * above the Iteration limit): patience stops an Optimizer that no longer
 * improves, and a fixed Prompt never tries to, so patience would end its
 * Runs early with fewer images. Every other rule is the same for both. At
 * the largest Iteration limit, 50, patience can only be 50 too: it then
 * fires only when no Iteration scored at all, in the last Iteration, where
 * the limit stops the Lane anyway (the Stop Reason then reads `patience`).
 */
export const armStopRules = (rules: StopRules): { readonly [A in Arm]: StopRules } => ({
  optimizer: rules,
  resample: { ...rules, patience: Math.min(MAX_ITERATIONS, rules.maxIterations + 1) },
});

/**
 * A Subject's Run request for one Image Model and Arm. Both Arms send the same
 * starting Prompt; the Resample Arm's Lane resends it every Iteration.
 */
function armRequest(subject: Subject, model: string, arm: Arm, settings: EvalSettings) {
  try {
    return decodeRequest({
      photos: subject.photos,
      faceChoices: [...subject.faceChoices].map(([photo, face]) => ({ photo, face })),
      pins: [],
      targetLook: subject.targetLook,
      budgetUsd: settings.budgetUsd,
      candidates: settings.candidates,
      lanes: [
        {
          model,
          ...(subject.prompt !== undefined && { prompt: subject.prompt }),
          ...(arm === "resample" && { resample: true }),
        },
      ],
      judge: settings.judge,
      optimizer: settings.optimizer,
      stopRules: armStopRules(settings.stopRules)[arm],
    });
  } catch (error) {
    throw new Error(`Subject ${subject.name}: ${errorMessage(error)}`);
  }
}

/**
 * Check every role's vendor before anything billable, as each Run would
 * before its first call: the loop's Judge, the second Judge, the Optimizer
 * (when a Run iterates) and every Image Model, each with its price.
 */
const checkVendors = (settings: EvalSettings) =>
  Effect.gen(function* () {
    const judges = yield* Judges;
    yield* judges.checkCredentials(settings.judge.model);
    yield* judges.checkCredentials(settings.evalJudge.model);
    if (settings.stopRules.maxIterations > 1) {
      const optimizers = yield* Optimizers;
      yield* optimizers.checkCredentials(settings.optimizer.model);
      yield* optimizers.get(settings.optimizer);
    }
    yield* judges.get(settings.judge);
    const evalJudge = yield* judges.get(settings.evalJudge);
    const imageModels = yield* ImageModels;
    yield* Effect.forEach(settings.models, (model) => imageModels.get(model));
    return evalJudge;
  });

/**
 * A Subject's photos validated as `photos:validate` and a Run do: every one
 * must be accepted, so each Arm's Runs use them all. Returns the held-out
 * references and the Reference Photos the second Judge sees, chosen as the
 * loop's Judge's are.
 */
const prepareSubject = (subject: Subject, dataDirectory: string) =>
  Effect.gen(function* () {
    const { report, accepted } = yield* validateReferencePhotos({
      paths: subject.photos,
      faceChoices: subject.faceChoices,
      dataDirectory,
    });
    const refused = report.photos.filter(({ verdict }) => verdict !== "accepted");
    if (refused.length > 0) {
      const listed = refused
        .map(
          (photo) =>
            `${photo.path}: ${photo.verdict}${"reason" in photo ? ` (${photo.reason})` : ""}`,
        )
        .join("; ");
      return yield* Effect.fail(
        new Error(
          `Subject ${subject.name}: every Reference Photo must be accepted (see photos:validate; choose faces in faces.json): ${listed}`,
        ),
      );
    }
    const heldOut = yield* heldOutReferences(
      report.photos.flatMap((photo) =>
        photo.verdict === "accepted" ? [{ path: photo.path, face: photo.face.face }] : [],
      ),
    );
    const judgePhotos = yield* selectJudgeReferences(accepted);
    const judgeReferences = yield* Effect.forEach(judgePhotos, (number) =>
      Effect.tryPromise(() =>
        readForJudge(accepted.find(({ photo }) => photo === number)!.stored.path),
      ),
    );
    return { heldOut, judgeReferences };
  });

/** A Subject's references for the evaluation (`prepareSubject`). */
interface PreparedSubject {
  readonly heldOut: readonly Embedding[];
  readonly judgeReferences: readonly EncodedImage[];
}

/** The second Judge across the evaluation, and how far its vendor has answered. */
interface SecondJudge {
  readonly judge: Judge;
  readonly weights: RubricWeights;
  /** The vendor's reason, once it turned a call away for good; no further call is made. */
  rejected: string | null;
  /** The vendor answered a call (judged, or refused to): its key works, so calls run in parallel. */
  proven: boolean;
}

/** How many second-Judge calls run at once once its key is proven. */
const EVAL_CONCURRENCY = 4;

/**
 * Every Candidate of a stored Run with its loop scores as the Run stored
 * them, and every one with an image scored by the held-out face model and,
 * when the held-out decode could read it, the second Judge (its calls on
 * `ledger`). Until the second Judge's vendor has answered a call (judged or
 * refused), Candidates are scored one at a time, so a rejected key costs one
 * call; after that, up to `EVAL_CONCURRENCY` at a time. The first rejection
 * stops the second Judge: later images are `skipped`, and `onRejected` says
 * so at once. Any other failure (a fault of the face model, a file, a
 * defect) fails the whole effect.
 */
const evaluateCandidates = (
  report: StoredRunReport,
  prepared: PreparedSubject,
  second: SecondJudge,
  ledger: EvalLedger,
  policy: RetryPolicy | undefined,
  onRejected: (reason: string) => void,
) => {
  const judged = (path: string, gate: string): Effect.Effect<EvalJudgeScore, Error> =>
    Effect.gen(function* () {
      if (second.rejected !== null) {
        return {
          status: "skipped",
          reason: `The second Judge was turned away: ${second.rejected}`,
        };
      }
      const score = yield* judgeImage(path, {
        judge: second.judge,
        references: prepared.judgeReferences,
        targetLook: report.targetLook,
        weights: second.weights,
        gate: ledger.gate(gate),
        ...(policy && { policy }),
      });
      if (score.status === "judge-failed" && score.cause === "non-recoverable") {
        if (second.rejected === null) {
          second.rejected = score.reason;
          onRejected(score.reason);
        }
      } else if (score.status === "judged" || score.cause === "refused") {
        second.proven = true;
      }
      return score;
    });
  const evaluate = (
    candidate: StoredRunReport["lanes"][number]["candidates"][number],
  ): Effect.Effect<EvaluatedCandidate, unknown, HeldOutFaceEmbedder> => {
    const loop = {
      iteration: candidate.iteration,
      candidate: candidate.candidate,
      outcome: candidate.outcome,
      loop: {
        judgeTotal:
          candidate.judgement?.status === "judged" ? candidate.judgement.weightedTotal : null,
        likeness: candidate.likeness ?? null,
      },
    };
    const { image } = candidate;
    if (!image) return Effect.succeed({ ...loop, heldOut: null, evalJudge: null });
    return Effect.gen(function* () {
      const heldOut = yield* scoreHeldOutImage(image.path, prepared.heldOut);
      const evalJudge: EvalJudgeScore =
        heldOut.status === "unreadable"
          ? heldOut
          : yield* judged(image.path, `${candidate.iteration}/${candidate.candidate}`);
      return { ...loop, heldOut, evalJudge } satisfies EvaluatedCandidate;
    });
  };
  return Effect.gen(function* () {
    const candidates = report.lanes[0]?.candidates ?? [];
    const scored: EvaluatedCandidate[] = [];
    // One at a time until the second Judge's key is proven (or rejected), then in parallel.
    while (scored.length < candidates.length && !second.proven && second.rejected === null) {
      scored.push(yield* evaluate(candidates[scored.length]!));
    }
    const rest = yield* Effect.forEach(candidates.slice(scored.length), evaluate, {
      concurrency: EVAL_CONCURRENCY,
    });
    return [...scored, ...rest];
  });
};

/** A Run's price sources as its report shows them. */
const pricesOf = (report: StoredRunReport): ArmRun["prices"] => ({
  imageModel: report.lanes[0]?.price ?? null,
  judge: report.judge.price ?? null,
  optimizer: report.optimizer.price ?? null,
});

/** The cost fields of a report's totals (they also hold the Budget and what remains of it). */
const costsOf = ({ estimatedUsd, actualUsd, committedUsd, unknownCostCalls }: CallCosts) => ({
  estimatedUsd,
  actualUsd,
  committedUsd,
  unknownCostCalls,
});

/**
 * Run every Subject's Arms on every Image Model at the same Budget and
 * stopping rules (`armStopRules`), one Run at a time, then score every
 * Candidate image of each with the held-out face model and the second Judge,
 * handing each Arm Run to `onRun` as soon as it is evaluated. Fails fast: a
 * Run that fails, can't be read back, or whose scoring meets a fault aborts
 * the evaluation after that Run is handed on with what it stored and spent
 * (`complete: false`). So does a Run stopped because a vendor turned the
 * loop's Judge or Optimizer away for good (`judge-failed`,
 * `optimizer-failed`): every later Run would pay for images it can't judge
 * or improve. A vendor's answer about one image (refused, failed, no face)
 * is a score, not a fault. An abort rejects with `EvalAborted`. Failing
 * before `onReady` (a key, a price, a photo, the face models) rejects without
 * anything billed or written.
 */
export async function runArms(
  subjects: readonly Subject[],
  settings: EvalSettings,
  environment: EvalEnvironment,
): Promise<void> {
  const { vendors, output, progress, warn, retryPolicy } = environment;
  const weights = judgeOnlyWeights(settings.judge.weights);
  // Every request is checked before anything is validated or billed.
  const plan = subjects.flatMap((subject, index) =>
    settings.models.flatMap((model) =>
      ARMS.map((arm) => ({
        index,
        subject,
        model,
        arm,
        request: armRequest(subject, model, arm, settings),
      })),
    ),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      environment.faceEmbedder,
      environment.heldOutEmbedder,
      vendors.judges,
      vendors.optimizers,
      vendors.imageModels,
    ),
  );
  return withCleanup(
    async () => {
      const second: SecondJudge = {
        judge: await runtime.runPromise(checkVendors(settings)),
        weights,
        rejected: null,
        proven: false,
      };
      const prepared: PreparedSubject[] = await runtime.runPromise(
        Effect.forEach(subjects, (subject) => prepareSubject(subject, environment.scratch)),
      );
      await environment.onReady();
      const application = await createRunApplication({
        databasePath: output.database,
        dataDirectory: output.dataDirectory,
        imageModels: vendors.imageModels,
        judges: vendors.judges,
        optimizers: vendors.optimizers,
        faceEmbedder: environment.faceEmbedder,
        // The operator names the Subjects folder on the command line.
        photoPaths: "operator",
        ...(retryPolicy && { retryPolicy }),
        ...(environment.wrapRunStoreClient && {
          wrapRunStoreClient: environment.wrapRunStoreClient,
        }),
        warn: (warning: RunWarning) =>
          warn({ ...warning, code: "run-warning", message: warning.warning }),
      });
      return withCleanup(
        async (): Promise<void> => {
          for (const { index, subject, model, arm, request } of plan) {
            const about = { subject: subject.name, model, arm };
            const label = `The Run of ${subject.name} on ${model} (${arm} Arm)`;
            progress({ event: "run-start", ...about });
            const unfinished: ArmRun = {
              ...about,
              runId: null,
              complete: false,
              stopReason: null,
              stopDetail: null,
              iterations: 0,
              armCost: null,
              evalCost: evalLedger().cost(),
              prices: { imageModel: null, judge: null, optimizer: null },
              candidates: [],
            };
            /**
             * Hand on `run` (what it stored and spent) and abort the evaluation with `reason`;
             * a failure handing it on is attached to the abort, which stays the error.
             */
            const abort = async (run: ArmRun, reason: string): Promise<never> => {
              progress({ event: "run-aborted", ...about, runId: run.runId, reason });
              const aborted = new EvalAborted(reason);
              await environment
                .onRun(run)
                .catch((error: unknown) => attachCleanupError(aborted, error));
              throw aborted;
            };

            let runId: string;
            try {
              ({ runId } = await application.start(request, (estimate) =>
                progress({ ...estimate, ...about }),
              ));
            } catch (error) {
              const reason = `${label} failed: ${errorMessage(error)}`;
              if (!(error instanceof RunFailedError)) return abort(unfinished, reason);
              // Stored before it failed: what it spent, if it can be read back.
              let stored: StoredRunReport;
              try {
                stored = await application.report(error.runId);
              } catch (readError) {
                return abort(
                  { ...unfinished, runId: error.runId },
                  `${reason}; reading it back failed too: ${errorMessage(readError)}`,
                );
              }
              return abort(
                {
                  ...unfinished,
                  runId: error.runId,
                  stopReason: stored.lanes[0]?.stopReason ?? null,
                  stopDetail: stored.lanes[0]?.stopDetail ?? null,
                  iterations: stored.lanes[0]?.iterations ?? 0,
                  armCost: costsOf(stored.totals),
                  prices: pricesOf(stored),
                },
                reason,
              );
            }
            let report: StoredRunReport;
            try {
              report = await application.report(runId);
            } catch (error) {
              return abort(
                { ...unfinished, runId },
                `Reading ${label.toLowerCase()} back failed: ${errorMessage(error)}`,
              );
            }
            const [lane] = report.lanes;
            const read: ArmRun = {
              ...unfinished,
              runId,
              stopReason: lane?.stopReason ?? null,
              stopDetail: lane?.stopDetail ?? null,
              iterations: lane?.iterations ?? 0,
              armCost: costsOf(report.totals),
              prices: pricesOf(report),
            };
            const ledger = evalLedger();
            let candidates: EvaluatedCandidate[];
            try {
              // runPromise rejects on a failure and on a defect (a throw while scoring).
              candidates = await runtime.runPromise(
                evaluateCandidates(
                  report,
                  prepared[index]!,
                  second,
                  ledger,
                  retryPolicy,
                  (reason) =>
                    warn({
                      code: "eval-judge-rejected",
                      message: `The second Judge ${settings.evalJudge.model} was turned away for good (${reason}); the remaining images are not judged by it`,
                    }),
                ),
              );
            } catch (error) {
              return abort(
                { ...read, evalCost: ledger.cost() },
                `Scoring ${label.toLowerCase()} failed: ${errorMessage(error)}`,
              );
            }
            const run: ArmRun = { ...read, complete: true, evalCost: ledger.cost(), candidates };
            if ((LANE_STOPS_WITH_DETAIL as readonly (string | null)[]).includes(run.stopReason)) {
              const role = run.stopReason === "judge-failed" ? "Judge" : "Optimizer";
              return abort(
                run,
                `${label} stopped ${run.stopReason}: ${run.stopDetail}. The vendor rejected the loop's ${role} for good (HTTP 401, 402, 403 or 404: its key, its model or the account's credit); fix it before running again`,
              );
            }
            await environment.onRun(run);
            progress({
              event: "run-evaluated",
              ...about,
              runId,
              armUsd: run.armCost?.actualUsd ?? null,
              evalUsd: run.evalCost.actualUsd,
            });
          }
        },
        () => application.close(),
      );
    },
    () => runtime.dispose(),
  );
}
