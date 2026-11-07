import {
  type CallKey,
  type CallSubject,
  type CandidateKey,
  type CandidateRecord,
  decodeReferencePhoto,
  errorMessage,
  imagePath,
  isStorableImageType,
  readForJudge,
  loadCharacterReference,
  type ReferencePhotoReport,
  resolveInsideDataDirectory,
  RunStore,
  type RunStoreError,
  storeImage,
  validateReferencePhotos,
} from "@iconograph/adapters";
import {
  bestCandidate,
  type CallEstimate,
  type CallGate,
  type CandidateOutcome,
  CURRENT_RUBRIC,
  DEFAULT_RETRY_POLICY,
  FaceEmbedder,
  fitsBudget,
  generateCandidate,
  type Generation,
  type ImageModel,
  ImageModels,
  type ImageRequest,
  initialPrompt,
  iterationResult,
  judgeCandidate,
  judgeFailed,
  Judges,
  type LaneStop,
  type LaneStopDetailReason,
  laneStopFields,
  laneStopReason,
  type LaneStopWithDetail,
  MAX_PROMPT_LENGTH,
  notSent,
  type OptimizerIteration,
  Optimizers,
  optimizePrompt,
  quoteOptimizerCall,
  recentHistory,
  type RetryPolicy,
  type RgbImage,
  type RunRequest,
  scoreCandidate,
  selectCharacterReferences,
  selectJudgeReferences,
  showsBudgetExhausted,
  toUsd,
} from "@iconograph/domain";
import { Context, Data, Effect } from "effect";
import type { EstimateEvent, LaneState } from "./schemas";

/** Iterations are numbered from 1. */
export const FIRST_ITERATION = 1;

/**
 * Which Reference Photo paths a Run may read: `confined` (the default) only
 * files inside the data volume, so a client can't make the server read
 * arbitrary files; `operator` any path, for the operator's own CLI.
 */
export type PhotoPaths = "confined" | "operator";

/** Where a Run keeps its files, how it retries, and which photo paths it reads. */
export class RunConfig extends Context.Service<
  RunConfig,
  {
    readonly dataDirectory: string;
    readonly retryPolicy: RetryPolicy;
    readonly photoPaths: PhotoPaths;
  }
>()("@iconograph/server/RunConfig") {}

export const defaultRunConfig = (dataDirectory: string): RunConfig["Service"] => ({
  dataDirectory,
  retryPolicy: DEFAULT_RETRY_POLICY,
  photoPaths: "confined",
});

/** A Run that can't proceed, for a reason the operator can fix. */
export class RunError extends Data.TaggedError("RunError")<{ message: string; cause?: unknown }> {}

/** A Run keeps its Rubric: one judged with another version than this build's can't go on. */
const keepsRubric = (runId: string, recorded: string, current: string) =>
  recorded === current
    ? Effect.void
    : Effect.fail(
        new RunError({
          message: `Run ${runId} was judged with ${recorded}; this build judges only with ${current}`,
        }),
      );

/** The stored (stripped) copies of the given accepted Reference Photos, in order. */
const storedPhotos = (photoReport: ReferencePhotoReport, photos: readonly number[]) => {
  const stored = new Map(
    photoReport.photos.flatMap((photo) =>
      photo.verdict === "accepted" ? [[photo.photo, photo.stored] as const] : [],
    ),
  );
  return photos.map((photo) => stored.get(photo)!);
};

/** Accepted Reference Photos as sent to an Image Model (at most 2048 px), in the given order. */
const loadReferences = (photoReport: ReferencePhotoReport, photos: readonly number[]) =>
  Effect.forEach(storedPhotos(photoReport, photos), loadCharacterReference);

/** A stored image as the Judge sees it (`readForJudge`). */
const forJudge = (path: string, what: string) =>
  Effect.tryPromise({
    try: () => readForJudge(path),
    catch: (error) =>
      new RunError({
        message: `Reading ${what} ${path} failed: ${errorMessage(error)}`,
        cause: error,
      }),
  });

/**
 * The request every Candidate of a Lane's Iteration is generated from: the
 * Prompt, the Lane's character references as sent and the Lane size, which an
 * adapter lists first among its sizes.
 */
const laneRequest = (
  photoReport: ReferencePhotoReport,
  characterReferences: readonly number[],
  prompt: string,
  model: ImageModel,
) =>
  Effect.map(
    loadReferences(photoReport, characterReferences),
    (references) =>
      ({ prompt, references, size: model.capabilities.sizes[0] }) satisfies ImageRequest,
  );

/** Log annotations naming the Candidate (or, for an Optimizer call, the Iteration) a warning is about. */
const about = ({ runId, lane, iteration, candidate }: CallSubject) =>
  Effect.annotateLogs({ runId, lane, iteration, ...(candidate !== null && { candidate }) });

/**
 * The Budget's view of one subject's calls. Attempts are numbered on from
 * the subject's calls among `calls` (those an earlier, interrupted execution
 * already made), so a re-executed step never reuses an attempt.
 */
const callGate = (
  store: RunStore["Service"],
  subject: CallSubject,
  model: string,
  calls: readonly CallKey[],
): CallGate<RunStoreError> => {
  const offset = calls.filter(
    (call) =>
      call.lane === subject.lane &&
      call.iteration === subject.iteration &&
      call.candidate === subject.candidate &&
      call.purpose === subject.purpose,
  ).length;
  return {
    reserve: (attempt, callEstimate) =>
      store.reserveCall({ ...subject, attempt: offset + attempt }, model, callEstimate),
    settle: (attempt, result) =>
      store.settleCall({ ...subject, attempt: offset + attempt }, result),
  };
};

/** A call to reserve: its subject (for logs) and its gate. */
interface Reservable {
  readonly key: CallSubject;
  readonly gate: CallGate<RunStoreError>;
}

/** Book a reserved call that was never sent at $0; one that can't be booked is logged. */
const settleNotSent = (items: readonly Reservable[], why: string) =>
  Effect.forEach(
    items,
    ({ key, gate }) =>
      gate
        .settle(0, notSent(why))
        .pipe(
          Effect.ignore({ log: "Warn", message: "Settling an unsent reservation failed" }),
          about(key),
        ),
    { discard: true },
  );

/**
 * Reserve each item's first call against the Budget, in order, until one
 * doesn't fit; returns the items reserved, a prefix of `items`. Each
 * reservation and its bookkeeping complete together, so an interrupt can't
 * leave a reservation that nothing knows of. If reserving fails or is
 * interrupted partway, the calls already reserved were never sent: each is
 * booked at $0.
 */
const reserveInOrder = <T extends Reservable>(items: readonly T[], estimate: CallEstimate) =>
  Effect.gen(function* () {
    const reserved: T[] = [];
    yield* Effect.gen(function* () {
      for (const item of items) {
        const fits = yield* Effect.uninterruptible(
          fitsBudget(item.gate.reserve(0, estimate)).pipe(
            Effect.tap((fits) =>
              Effect.sync(() => {
                if (fits) reserved.push(item);
              }),
            ),
          ),
        );
        if (!fits) break;
      }
    }).pipe(
      Effect.onError(() =>
        settleNotSent(reserved, "reserving the Lane's calls failed or was interrupted"),
      ),
    );
    return reserved;
  });

/**
 * Prepare a Run: check the Judge's key and, for a Run of more than one
 * Iteration with a Lane that isn't a Resample Lane, the Optimizer's, then get
 * each with its price and every Lane's Image Model (credentials and price,
 * before anything billable), validate the Reference Photos, freeze the Run
 * with its Identity Anchor and Ceiling, choose each Lane's character
 * references from its own accepted photos and the Judge's Reference Photos,
 * store each Lane's initial Prompt (its own, else the one built from the
 * Target Look) as its first Iteration, and announce at most what the Run can
 * cost if every Lane runs all its Iterations, each call at its first-call
 * estimate (retries not included).
 */
export const prepareRun = (
  runId: string,
  request: RunRequest,
  announce: (event: EstimateEvent) => Promise<void>,
) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const imageModels = yield* ImageModels;
    const { dataDirectory, photoPaths } = yield* RunConfig;
    // The photo paths first: a client's path outside the data volume is refused before anything
    // else. Every Lane's photos are numbers into these paths, so this confines every Lane's too.
    const paths =
      photoPaths === "operator"
        ? request.photos
        : yield* Effect.forEach(request.photos, (photo) =>
            Effect.tryPromise({
              try: () => resolveInsideDataDirectory(photo, dataDirectory),
              catch: (error) => new RunError({ message: errorMessage(error), cause: error }),
            }),
          );
    // A Resample Run needs tables that can hold its `resampled` Prompts (older ones can't).
    const optimizingLanes = request.lanes.filter(({ resample }) => !resample).length;
    if (optimizingLanes < request.lanes.length) yield* store.checkResampleLanes;
    // Then the Judge and the Optimizer: a Run without either's key fails before any price is
    // looked up. A Run of one Iteration, or of Resample Lanes only, never calls the Optimizer,
    // so it needs neither.
    const { maxIterations } = request.stopRules;
    const optimizes = maxIterations > 1 && optimizingLanes > 0;
    const judges = yield* Judges;
    const optimizers = yield* Optimizers;
    yield* judges.checkCredentials(request.judge.model);
    if (optimizes) yield* optimizers.checkCredentials(request.optimizer.model);
    const judge = yield* judges.get(request.judge);
    const optimizer = optimizes ? yield* optimizers.get(request.optimizer) : null;
    const models = yield* Effect.forEach(request.lanes, ({ model }) => imageModels.get(model));

    // The request schema already rejects two choices for one photo.
    const faceChoices = new Map(request.faceChoices.map(({ photo, face }) => [photo, face]));
    const { report, accepted } = yield* validateReferencePhotos({
      paths,
      faceChoices,
      dataDirectory,
    });
    // Decided by the warning code, never its message; `identity` is absent exactly then.
    const { identity } = report;
    if (report.warnings.some(({ code }) => code === "none-accepted") || !identity) {
      return yield* new RunError({
        message:
          "No Reference Photo was accepted, so the Run has no Identity Anchor; see photos:validate",
      });
    }
    const lanes = yield* Effect.forEach(models, (model, lane) =>
      Effect.gen(function* () {
        const label = `Lane ${lane} (${model.model})`;
        // Without its own photo list, a Lane may send any accepted photo.
        let eligible = accepted;
        const own = request.lanes[lane]!.photos;
        if (own) {
          const outside = request.pins.find((photo) => !own.includes(photo));
          if (outside !== undefined) {
            return yield* new RunError({
              message: `Pinned photo ${outside} is not among the photos of ${label}`,
            });
          }
          eligible = accepted.filter(({ photo }) => own.includes(photo));
          if (eligible.length === 0) {
            return yield* new RunError({
              message: `None of the photos of ${label} (${own.join(", ")}) was accepted; see photos:validate`,
            });
          }
        }
        const characterReferences = yield* selectCharacterReferences(eligible, {
          max: model.capabilities.maxCharacterReferences,
          pinned: request.pins,
        });
        return { lane, model: model.model, price: model.price, characterReferences };
      }),
    );

    const judgeReferences = yield* selectJudgeReferences(accepted);

    yield* store.createRun({ id: runId, request, photoReport: { ...report, identity } });
    yield* store.createJudge(runId, {
      price: judge.price,
      rubricVersion: judge.rubric.version,
      referencePhotos: judgeReferences,
    });
    if (optimizer) yield* store.createOptimizer(runId, optimizer.price);
    const defaultPrompt = initialPrompt(request.targetLook);
    const prompts = request.lanes.map(({ prompt }) => prompt ?? defaultPrompt);
    for (const lane of lanes) {
      yield* store.createLane(runId, lane);
      yield* store.createIteration(
        { runId, lane: lane.lane, iteration: FIRST_ITERATION },
        prompts[lane.lane]!,
        { source: "initial" },
      );
    }

    // At most: every Lane runs every Iteration, each call at its first-call estimate (retries
    // not included). Iteration 1 sends the Lane's Prompt; later ones and the Optimizer calls
    // between them are quoted at the longest Prompts and histories the Run allows (a Resample
    // Lane resends its Prompt and makes no Optimizer call). Each call is checked against the
    // Budget at its own estimate.
    const optimizerPerCall = optimizer
      ? quoteOptimizerCall(optimizer.estimate, request.targetLook, request.candidates).micros
      : 0;
    const longestPrompt = "\u0001".repeat(MAX_PROMPT_LENGTH);
    const estimates = yield* Effect.forEach(lanes, ({ lane, characterReferences }) => {
      const model = models[lane]!;
      return Effect.gen(function* () {
        const first = yield* laneRequest(report, characterReferences, prompts[lane]!, model);
        const later = request.lanes[lane]!.resample ? first : { ...first, prompt: longestPrompt };
        const perCall = model.estimate(first).micros;
        return {
          lane,
          model: model.model,
          perCall,
          micros:
            (perCall + model.estimate(later).micros * (maxIterations - 1)) * request.candidates,
        };
      });
    });
    const judgeCalls = request.candidates * lanes.length * maxIterations;
    const judgePerCall = judge.estimate({
      references: judgeReferences.length,
      targetLook: request.targetLook,
    }).micros;
    const optimizerCalls = optimizingLanes * (maxIterations - 1);
    const imageMicros = estimates.reduce((sum, { micros }) => sum + micros, 0);
    const judgeMicros = judgePerCall * judgeCalls;
    const optimizerMicros = optimizerPerCall * optimizerCalls;
    yield* Effect.promise(() =>
      announce({
        event: "estimate",
        runId,
        budgetUsd: request.budgetUsd,
        maxIterations,
        estimatedUsd: toUsd(imageMicros + judgeMicros + optimizerMicros),
        lanes: estimates.map(({ lane, model, perCall, micros }) => ({
          lane,
          model,
          candidates: request.candidates,
          perCallUsd: toUsd(perCall),
          estimatedUsd: toUsd(micros),
        })),
        judge: {
          model: judge.model,
          effort: judge.effort,
          calls: judgeCalls,
          perCallUsd: toUsd(judgePerCall),
          estimatedUsd: toUsd(judgeMicros),
        },
        optimizer: {
          model: request.optimizer.model,
          effort: request.optimizer.effort,
          calls: optimizerCalls,
          perCallUsd: toUsd(optimizerPerCall),
          estimatedUsd: toUsd(optimizerMicros),
        },
      }),
    );
    return lanes.map(({ lane, model }): LaneState => ({
      runId,
      lane,
      model,
      iteration: FIRST_ITERATION,
      stopReason: null,
    }));
  });

/**
 * Generate one Iteration's Candidates. Every first call is reserved against
 * the Budget in Candidate order before any is launched, so parallel calls
 * can't overspend; a call that doesn't fit isn't made, its Candidate is
 * stored Failed (`budgetExhausted`), and the Lane stops after the Iteration
 * (`budget-exhausted`, unless a rule before it holds: `laneStopReason`). The
 * reserved Candidates then run in parallel, each
 * retrying transient errors (each retry reserved first). Every Candidate is
 * stored as soon as it ends: its image as a content-addressed file. A
 * re-executed step generates only the Candidates not stored yet, numbering
 * their calls on. The model prices calls at the Lane's recorded price, the
 * one the estimate showed.
 */
export const generateIteration = (input: LaneState) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { dataDirectory, retryPolicy } = yield* RunConfig;
    const run = yield* store.loadRun(input.runId);
    const lane = (yield* store.loadLanes(input.runId)).find(({ lane }) => lane === input.lane);
    if (!lane) {
      return yield* new RunError({ message: `Lane ${input.lane} of Run ${input.runId} not found` });
    }
    const model = yield* (yield* ImageModels).get(input.model, lane.price);
    const iteration = { runId: input.runId, lane: input.lane, iteration: input.iteration };
    const prompt = yield* store.loadPrompt(iteration);
    const request = yield* laneRequest(run.photoReport, lane.characterReferences, prompt, model);
    const estimate = model.estimate(request);

    const { candidates: stored, calls } = yield* store.loadRecords(input.runId, input.lane);
    const saved = new Set(
      stored
        .filter(({ iteration }) => iteration === input.iteration)
        .map(({ candidate }) => candidate),
    );
    const pending = Array.from({ length: run.request.candidates }, (_, candidate) => candidate)
      .filter((candidate) => !saved.has(candidate))
      .map((candidate) => {
        const key = { ...iteration, candidate, purpose: "generate" as const };
        return { key, gate: callGate(store, key, model.model, calls) };
      });
    const reserved = yield* reserveInOrder(pending, estimate);
    const notGenerated: CandidateOutcome = {
      _tag: "Failed",
      reason: "Not generated: the image call didn't fit the Budget",
      budgetExhausted: true,
    };

    /**
     * Store one finished Candidate: its image to score, or its final outcome.
     * An image of a type the store can't take is a Failed Candidate; a disk
     * fault while storing fails the step (the image's call is already settled).
     */
    const save = (key: CandidateKey, generation: Generation) =>
      Effect.gen(function* () {
        if (generation.kind !== "image") {
          const outcome: CandidateOutcome =
            generation.kind === "refused"
              ? { _tag: "Refused", reason: generation.reason }
              : {
                  _tag: "Failed",
                  reason: generation.reason,
                  ...(generation.budgetExhausted && { budgetExhausted: true as const }),
                };
          yield* store.saveCandidate(key, { outcome, image: null });
          return outcome;
        }
        const { bytes, mimeType } = generation.image;
        if (!isStorableImageType(mimeType)) {
          const outcome: CandidateOutcome = {
            _tag: "Failed",
            reason: `The image's type ${mimeType} is not supported`,
          };
          yield* store.saveCandidate(key, { outcome, image: null });
          return outcome;
        }
        const { sha256 } = yield* Effect.tryPromise({
          try: () => storeImage(bytes, mimeType, dataDirectory),
          catch: (error) =>
            new RunError({
              message: `Storing Candidate ${key.candidate}'s image failed: ${errorMessage(error)}`,
              cause: error,
            }),
        });
        yield* store.saveCandidate(key, { outcome: null, image: { sha256, type: mimeType } });
        return null;
      });

    const outcomes = yield* Effect.forEach(
      reserved,
      ({ key, gate }) =>
        generateCandidate({ model, request, gate, policy: retryPolicy }).pipe(
          about(key),
          Effect.flatMap((generation) => save(key, generation)),
        ),
      { concurrency: "unbounded" },
    );
    // Reserved in order until one didn't fit: the rest are stored Failed, so a re-executed
    // Iteration sees why too. Saved only after the reserved calls ran, so no reservation is left
    // unsettled between reserving and launching.
    for (const { key } of pending.slice(reserved.length)) {
      yield* store.saveCandidate(key, { outcome: notGenerated, image: null });
      outcomes.push(notGenerated);
    }
    const budgetExhausted = outcomes.some((outcome) => showsBudgetExhausted({ outcome }));
    return {
      ...input,
      stopReason: budgetExhausted ? "budget-exhausted" : null,
    } satisfies LaneState;
  });

/**
 * Score the Iteration's generated Candidates against the Identity Gate: no
 * face or below the Gate is Gated, otherwise Scored with its Likeness. An
 * image the face pipeline can't decode is Failed; a face-model fault fails the
 * Iteration. The Lane's state passes on unchanged.
 */
export const scoreIteration = (input: LaneState) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const embedder = yield* FaceEmbedder;
    const { dataDirectory } = yield* RunConfig;
    const run = yield* store.loadRun(input.runId);
    const scale = { gate: run.identity.gate, ceiling: run.identity.ceiling.value };
    const score = (image: RgbImage) =>
      Effect.gen(function* () {
        const faces = yield* embedder.detect(image);
        const embeddings = yield* Effect.forEach(faces, (face) => embedder.embed(image, face));
        return scoreCandidate(embeddings, run.identity.anchor, scale);
      });
    const candidates = (yield* store.loadCandidates(input.runId, input.lane)).filter(
      ({ iteration }) => iteration === input.iteration,
    );
    for (const candidate of candidates) {
      if (candidate.outcome !== null || candidate.image === null) continue;
      const path = imagePath(dataDirectory, candidate.image.sha256, candidate.image.type);
      // Only bytes that aren't a usable image fail the Candidate; read faults fail the step.
      const outcome = yield* decodeReferencePhoto(path).pipe(
        Effect.flatMap(({ image }) => score(image)),
        Effect.catchTag("ReferencePhotoError", (error) =>
          error.stage === "decoded"
            ? Effect.succeed<CandidateOutcome>({
                _tag: "Failed",
                reason: `The Candidate image could not be decoded: ${error.detail ?? error.message}`,
              })
            : Effect.fail(
                new RunError({
                  message: `Reading Candidate ${candidate.candidate}'s image ${path} failed: ${error.detail ?? error.message}`,
                  cause: error,
                }),
              ),
        ),
      );
      yield* store.setCandidateOutcome(candidate, outcome);
    }
    return input;
  });

/** A Scored Candidate with its stored image. */
type ScoredCandidate = CandidateRecord & {
  outcome: Extract<CandidateOutcome, { _tag: "Scored" }>;
  image: NonNullable<CandidateRecord["image"]>;
};

/**
 * Judge the Iteration's Scored Candidates; Gated, Refused and Failed ones are
 * never judged. Each Judge call sees the Run's Reference Photos for the Judge
 * (at most 3, in their fixed order), then the Candidate. As in generation,
 * every first call is reserved in Candidate order before any is launched, and
 * each transient retry is reserved first; a call that doesn't fit isn't made,
 * its Candidate is marked judge-failed for the Budget, and the Lane stops
 * after the Iteration (`budget-exhausted`, unless a rule before it holds). A
 * call the vendor turns away for good marks its Candidate judge-failed
 * (`non-recoverable`) and, once the Iteration's calls have settled, the
 * optimize phase stops the Lane (`judge-failed`). Every judgement is stored as
 * soon as it exists,
 * with the Rubric version; a Candidate already judged is skipped, so a
 * re-executed step doesn't call the Judge again. A failed judging leaves the
 * Candidate's Likeness, never a made-up score.
 */
export const judgeIteration = (input: LaneState) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { dataDirectory, retryPolicy } = yield* RunConfig;
    const run = yield* store.loadRun(input.runId);
    const record = yield* store.loadJudge(input.runId);
    if (!record) return yield* new RunError({ message: `Run ${input.runId} has no Judge` });
    const judge = yield* (yield* Judges).get(run.request.judge, record.price);
    yield* keepsRubric(input.runId, record.rubricVersion, judge.rubric.version);
    const pending = (yield* store.loadCandidates(input.runId, input.lane)).filter(
      (candidate): candidate is ScoredCandidate =>
        candidate.iteration === input.iteration &&
        candidate.outcome?._tag === "Scored" &&
        candidate.judgement === null &&
        candidate.image !== null,
    );
    // Nothing left to judge: the Lane's state stands (the stored judgements show any Judge call
    // that didn't fit; the optimize phase reads them).
    if (pending.length === 0) return input;

    // Everything the calls need is read before any is reserved. A step re-executed after a
    // Judge call whose judgement wasn't saved numbers its calls on.
    const references = yield* Effect.forEach(
      storedPhotos(run.photoReport, record.referencePhotos),
      (stored) => forJudge(stored.path, "Reference Photo"),
    );
    const items = yield* Effect.forEach(pending, (candidate) => {
      const path = imagePath(dataDirectory, candidate.image.sha256, candidate.image.type);
      return forJudge(path, `Candidate ${candidate.candidate}'s image`).pipe(
        Effect.map((image) => {
          const key = {
            runId: candidate.runId,
            lane: candidate.lane,
            iteration: candidate.iteration,
            candidate: candidate.candidate,
            purpose: "judge" as const,
          };
          const gate = callGate(store, key, judge.model, candidate.calls);
          return { key, gate, candidate, image };
        }),
      );
    });
    const estimate = judge.estimate({
      references: references.length,
      targetLook: run.request.targetLook,
    });
    const reserved = yield* reserveInOrder(items, estimate);

    const judgements = yield* Effect.forEach(
      reserved,
      ({ key, candidate, image, gate }) =>
        judgeCandidate({
          judge,
          request: { references, candidate: image, targetLook: run.request.targetLook },
          estimate,
          likeness: candidate.outcome.likeness,
          weights: run.request.judge.weights,
          gate,
          policy: retryPolicy,
        }).pipe(
          about(key),
          Effect.tap((judgement) => store.saveJudgement(key, judgement)),
        ),
      { concurrency: "unbounded" },
    );
    // Reserved in order until one didn't fit: the rest weren't reserved. Saved only after the
    // reserved calls ran, so no reservation is left unsettled between reserving and launching.
    for (const { key } of items.slice(reserved.length)) {
      const judgement = judgeFailed(
        judge.rubric,
        "budget-exhausted",
        "Not judged: the Judge call didn't fit the Budget",
      );
      yield* store.saveJudgement(key, judgement);
      judgements.push(judgement);
    }
    const budgetExhausted = judgements.some((judgement) => showsBudgetExhausted({ judgement }));
    return budgetExhausted ? { ...input, stopReason: "budget-exhausted" as const } : input;
  });

/** The warning when a role's vendor turned it away for good, which stops the Lane. */
const TURNED_AWAY: { readonly [R in LaneStopDetailReason]: string } = {
  "optimizer-failed": "The vendor turned the Optimizer away for good; the Lane stops",
  "judge-failed": "The vendor turned the Judge away for good; the Lane stops",
};

/**
 * End an Iteration: decide whether the Lane stops (`laneStopReason` over its
 * Iterations so far, with a call of this one that didn't fit the Budget,
 * whether this execution saw it or the stored Candidates show it) and record
 * why, with the vendor's reason and a warning when a Judge call was turned
 * away for good (`judge-failed`); otherwise store the next Iteration, with
 * the Prompt the Optimizer writes from the Lane's own recent history
 * (`recentHistory`; never another Lane's) and the Target Look, or, in a
 * Resample Lane, with the Lane's initial Prompt again and no Optimizer call.
 * The Optimizer call belongs to this Iteration (it is booked under it) and is
 * reserved against the Budget first, as every billable call is; one that
 * doesn't fit, or a retry that doesn't, isn't made and the Lane stops with
 * `budget-exhausted`. One the vendor turns away for good stops the Lane at
 * once with `optimizer-failed`, the vendor's reason and a warning, storing no
 * next Iteration. When optimizing fails otherwise (a refusal, an unusable
 * answer, retries that ran out), the next Iteration keeps the last Prompt,
 * records why, and a warning says so. A re-executed step that finds the next
 * Iteration stored moves on to it without calling again.
 */
export const optimizeIteration = (input: LaneState) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { retryPolicy } = yield* RunConfig;
    const run = yield* store.loadRun(input.runId);
    // Candidates for the stopping rules and the history; calls to number a re-executed call.
    const { candidates, calls } = yield* store.loadRecords(input.runId, input.lane);
    const iterations = yield* store.loadIterations(input.runId, input.lane);
    const history = iterations
      .filter(({ iteration }) => iteration <= input.iteration)
      .map(({ iteration, prompt }): OptimizerIteration => ({
        iteration,
        prompt,
        candidates: candidates.filter((candidate) => candidate.iteration === iteration),
      }));
    const key = {
      runId: input.runId,
      lane: input.lane,
      iteration: input.iteration,
      candidate: null,
      purpose: "optimize" as const,
    };
    const stop = (laneStop: LaneStop) =>
      store
        .stopLane(input.runId, input.lane, laneStop)
        .pipe(
          Effect.as({ ...input, stopReason: laneStopFields(laneStop).reason } satisfies LaneState),
        );
    const turnedAway = (laneStop: LaneStopWithDetail) =>
      Effect.logWarning(TURNED_AWAY[laneStop.reason]).pipe(
        Effect.annotateLogs({ reason: laneStop.detail }),
        about(key),
        Effect.andThen(stop(laneStop)),
      );
    const results = history.map(({ candidates }) => iterationResult(candidates));
    const laneStop = laneStopReason(
      results,
      run.request.stopRules,
      input.stopReason === "budget-exhausted",
    );
    if (laneStop !== null) {
      return yield* typeof laneStop === "string" ? stop(laneStop) : turnedAway(laneStop);
    }

    const next = { runId: input.runId, lane: input.lane, iteration: input.iteration + 1 };
    const proceed: LaneState = { ...input, iteration: next.iteration, stopReason: null };
    if (iterations.some(({ iteration }) => iteration === next.iteration)) return proceed;
    if (run.request.lanes[input.lane]!.resample) {
      yield* store.createIteration(next, history[0]!.prompt, { source: "resampled" });
      return proceed;
    }

    const price = yield* store.loadOptimizer(input.runId);
    if (!price) return yield* new RunError({ message: `Run ${input.runId} has no Optimizer` });
    const optimizer = yield* (yield* Optimizers).get(run.request.optimizer, price);
    const request = { targetLook: run.request.targetLook, history: recentHistory(history) };
    const estimate = optimizer.estimate(request);
    // A step re-executed after an Optimizer call whose Prompt wasn't saved numbers its calls on.
    const [reserved] = yield* reserveInOrder(
      [{ key, gate: callGate(store, key, optimizer.model, calls) }],
      estimate,
    );
    if (!reserved) return yield* stop("budget-exhausted");
    const optimization = yield* optimizePrompt({
      optimizer,
      request,
      estimate,
      gate: reserved.gate,
      policy: retryPolicy,
    }).pipe(about(key));
    if (optimization.kind === "budget-exhausted") return yield* stop("budget-exhausted");
    if (optimization.kind === "non-recoverable") {
      return yield* turnedAway({ reason: "optimizer-failed", detail: optimization.reason });
    }
    if (optimization.kind === "kept") {
      yield* Effect.logWarning("Optimizing failed; the next Iteration keeps the last Prompt").pipe(
        Effect.annotateLogs({ reason: optimization.reason }),
        about(key),
      );
    }
    yield* optimization.kind === "rewritten"
      ? store.createIteration(next, optimization.prompt, { source: "optimizer" })
      : store.createIteration(next, history.at(-1)!.prompt, {
          source: "kept",
          reason: optimization.reason,
        });
    return proceed;
  });

/**
 * One Iteration of a Lane: generate → score → judge → optimize. A Lane that
 * already stopped (an earlier execution recorded why) runs nothing more. Each
 * phase finds what an earlier, interrupted execution stored (Candidates,
 * outcomes, judgements, the next Iteration), so a call whose result was
 * stored is never made again; one whose call ran but whose result was lost
 * is made again, under the next attempt number, and billed again.
 */
export const runIteration = (input: LaneState) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const lanes = yield* store.loadLanes(input.runId);
    const stopped = lanes.find(({ lane }) => lane === input.lane)?.stopReason;
    if (stopped) return { ...input, stopReason: stopped } satisfies LaneState;
    // Checked before any image is paid for, against CURRENT_RUBRIC: every Judge is built on it.
    // The judge phase checks the Judge it gets again.
    const record = yield* store.loadJudge(input.runId);
    if (record) yield* keepsRubric(input.runId, record.rubricVersion, CURRENT_RUBRIC.version);
    return yield* generateIteration(input).pipe(
      Effect.flatMap(scoreIteration),
      Effect.flatMap(judgeIteration),
      Effect.flatMap(optimizeIteration),
    );
  });

/**
 * Stop every Lane of the cancelled Run that hasn't stopped yet with
 * `cancelled`. The Run workflow's `onFinish` runs it (`CancelRecordings`,
 * which turns a failure into a warning).
 */
export const recordCancelledLanes = (runId: string) =>
  RunStore.use((store) => store.cancelLanes(runId));

/** A Lane's best Candidate (`bestCandidate`) as results show it; null when none was judged. */
export function bestCandidateView(candidates: readonly CandidateRecord[]) {
  const best = bestCandidate(candidates);
  return (
    best && {
      iteration: best.candidate.iteration,
      candidate: best.candidate.candidate,
      score: best.score,
    }
  );
}

/**
 * A stopped Lane's result: why it stopped (with the vendor's reason as its
 * stored detail, for `LANE_STOPS_WITH_DETAIL`), how many Iterations it began
 * (each has its Prompt stored), and its best Candidate.
 */
export const laneResult = (input: LaneState) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const candidates = yield* store.loadCandidates(input.runId, input.lane);
    const stored = (yield* store.loadLanes(input.runId)).find(({ lane }) => lane === input.lane);
    return {
      runId: input.runId,
      lane: input.lane,
      stopReason: input.stopReason,
      // The detail belongs to the stored stop, which the step's reason is unless one came first.
      stopDetail: stored?.stopReason === input.stopReason ? stored.stopDetail : null,
      iterations: (yield* store.loadIterations(input.runId, input.lane)).length,
      best: bestCandidateView(candidates),
    };
  });
