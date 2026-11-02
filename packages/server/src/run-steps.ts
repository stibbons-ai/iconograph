import {
  type CallPurpose,
  type CandidateKey,
  type CandidateRecord,
  decodeReferencePhoto,
  errorMessage,
  imagePath,
  isStorableImageType,
  readImageAtMost,
  loadCharacterReference,
  type ReferencePhotoReport,
  resolveInsideDataDirectory,
  RunStore,
  type RunStoreError,
  storeImage,
  validateReferencePhotos,
} from "@iconograph/adapters";
import {
  type CallEstimate,
  type CallGate,
  type CandidateOutcome,
  DEFAULT_RETRY_POLICY,
  FaceEmbedder,
  fitsBudget,
  generateCandidate,
  type Generation,
  type ImageModel,
  ImageModels,
  type ImageRequest,
  initialPrompt,
  JUDGE_IMAGE_MAX_SIDE,
  judgeCandidate,
  judgeFailed,
  Judges,
  notSent,
  type RetryPolicy,
  type RgbImage,
  type RunRequest,
  scoreCandidate,
  selectCharacterReferences,
  selectJudgeReferences,
  toUsd,
} from "@iconograph/domain";
import { Context, Data, Effect } from "effect";
import type { EstimateEvent, LaneGenerated, LaneInput, LaneResult } from "./schemas";

/** M0 runs one Iteration per Lane; Iterations are numbered from 1. */
export const ITERATION = 1;

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

/** A stored image as the Judge sees it: normalised (upright, on white, JPEG), at most `JUDGE_IMAGE_MAX_SIDE` px. */
const forJudge = (path: string, mimeType: string, what: string) =>
  Effect.tryPromise({
    try: () => readImageAtMost(path, mimeType, JUDGE_IMAGE_MAX_SIDE, { normalise: true }),
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

/** Log annotations naming the Candidate a warning is about. */
const about = ({ runId, lane, iteration, candidate }: CandidateKey) =>
  Effect.annotateLogs({ runId, lane, iteration, candidate });

/** The Budget's view of one Candidate's calls for `purpose`, numbering attempts from `offset`. */
const candidateGate = (
  store: RunStore["Service"],
  key: CandidateKey,
  purpose: CallPurpose,
  model: string,
  offset = 0,
): CallGate<RunStoreError> => ({
  reserve: (attempt, callEstimate) =>
    store.reserveCall({ ...key, purpose, attempt: offset + attempt }, model, callEstimate),
  settle: (attempt, result) =>
    store.settleCall({ ...key, purpose, attempt: offset + attempt }, result),
});

/** A Candidate's call to reserve: its key (for logs) and its gate. */
interface Reservable {
  readonly key: CandidateKey;
  readonly gate: CallGate<RunStoreError>;
}

/**
 * Reserve each item's first call against the Budget, in order, until one
 * doesn't fit; returns the items reserved, a prefix of `items`. If reserving
 * fails or is interrupted partway, the calls already reserved were never
 * sent: each is booked at $0, and one that can't be booked is logged.
 */
const reserveInOrder = <T extends Reservable>(items: readonly T[], estimate: CallEstimate) =>
  Effect.gen(function* () {
    const reserved: T[] = [];
    const settleNotSent = Effect.forEach(
      reserved,
      ({ key, gate }) =>
        gate
          .settle(0, notSent("reserving the Lane's calls failed or was interrupted"))
          .pipe(
            Effect.ignore({ log: "Warn", message: "Settling an unsent reservation failed" }),
            about(key),
          ),
      { discard: true },
    );
    yield* Effect.gen(function* () {
      for (const item of items) {
        if (!(yield* fitsBudget(item.gate.reserve(0, estimate)))) break;
        reserved.push(item);
      }
    }).pipe(Effect.onError(() => settleNotSent));
    return reserved;
  });

/**
 * Prepare a Run: get every Lane's Image Model and the Judge (credentials and
 * price, before anything billable), validate the Reference Photos, freeze the
 * Run with its Identity Anchor and Ceiling, choose each Lane's character
 * references from its own accepted photos and the Judge's Reference Photos,
 * store each Lane's initial Prompt (its own, else the one built from the
 * Target Look), and announce the estimated cost.
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
    // Then the Judge: a Run without the Judge's key fails before any price is looked up.
    const judge = yield* (yield* Judges).get(request.judge);
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
    const defaultPrompt = initialPrompt(request.targetLook);
    const prompts = request.lanes.map(({ prompt }) => prompt ?? defaultPrompt);
    for (const lane of lanes) {
      yield* store.createLane(runId, lane);
      yield* store.createIteration(
        { runId, lane: lane.lane, iteration: ITERATION },
        prompts[lane.lane]!,
      );
    }

    const estimates = yield* Effect.forEach(lanes, ({ lane, characterReferences }) => {
      const model = models[lane]!;
      const prompt = prompts[lane]!;
      return Effect.map(laneRequest(report, characterReferences, prompt, model), (laneInput) => {
        const perCall = model.estimate(laneInput).micros;
        return { lane, model: model.model, perCall, micros: perCall * request.candidates };
      });
    });
    const judgeCalls = request.candidates * lanes.length;
    const judgePerCall = judge.estimate({
      references: judgeReferences.length,
      targetLook: request.targetLook,
    }).micros;
    const imageMicros = estimates.reduce((sum, { micros }) => sum + micros, 0);
    const judgeMicros = judgePerCall * judgeCalls;
    yield* Effect.promise(() =>
      announce({
        event: "estimate",
        runId,
        budgetUsd: request.budgetUsd,
        estimatedUsd: toUsd(imageMicros + judgeMicros),
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
      }),
    );
    return lanes.map(({ lane, model }) => ({ runId, lane, model })) satisfies LaneInput[];
  });

/**
 * Generate one Iteration's Candidates. Every first call is reserved against
 * the Budget in Candidate order before any is launched, so parallel calls
 * can't overspend; a call that doesn't fit isn't made and the Lane stops with
 * `budget-exhausted`. The reserved Candidates then run in parallel, each
 * retrying transient errors (each retry reserved first). Every Candidate is
 * stored as soon as it ends: its image as a content-addressed file. The model
 * prices calls at the Lane's recorded price, the one the estimate showed.
 */
export const generateIteration = (input: LaneInput) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { dataDirectory, retryPolicy } = yield* RunConfig;
    const run = yield* store.loadRun(input.runId);
    const lane = (yield* store.loadLanes(input.runId)).find(({ lane }) => lane === input.lane);
    if (!lane) {
      return yield* new RunError({ message: `Lane ${input.lane} of Run ${input.runId} not found` });
    }
    const model = yield* (yield* ImageModels).get(input.model, lane.price);
    const iteration = { runId: input.runId, lane: input.lane, iteration: ITERATION };
    const prompt = yield* store.loadPrompt(iteration);
    const request = yield* laneRequest(run.photoReport, lane.characterReferences, prompt, model);
    const estimate = model.estimate(request);

    const reserved = yield* reserveInOrder(
      Array.from({ length: run.request.candidates }, (_, candidate) => {
        const key = { ...iteration, candidate };
        return { key, gate: candidateGate(store, key, "generate", model.model) };
      }),
      estimate,
    );

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
              : { _tag: "Failed", reason: generation.reason };
          return yield* store.saveCandidate(key, { outcome, image: null });
        }
        const { bytes, mimeType } = generation.image;
        if (!isStorableImageType(mimeType)) {
          return yield* store.saveCandidate(key, {
            outcome: { _tag: "Failed", reason: `The image's type ${mimeType} is not supported` },
            image: null,
          });
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
      });

    const generations = yield* Effect.forEach(
      reserved,
      ({ key, gate }) =>
        generateCandidate({ model, request, gate, policy: retryPolicy }).pipe(
          about(key),
          Effect.tap((generation) => save(key, generation)),
        ),
      { concurrency: "unbounded" },
    );
    const budgetExhausted =
      reserved.length < run.request.candidates ||
      generations.some((generation) => generation.kind === "failed" && generation.budgetExhausted);
    const stopReason = budgetExhausted ? "budget-exhausted" : null;
    if (stopReason) yield* store.stopLane(input.runId, input.lane, stopReason);
    return { runId: input.runId, lane: input.lane, stopReason } satisfies LaneGenerated;
  });

/**
 * Score the Iteration's generated Candidates against the Identity Gate: no
 * face or below the Gate is Gated, otherwise Scored with its Likeness. An
 * image the face pipeline can't decode is Failed; a face-model fault fails the
 * step. The Lane's stop reason passes on to the judge step.
 */
export const scoreIteration = (input: LaneGenerated) =>
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
    const candidates = yield* store.loadCandidates(input.runId, input.lane);
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
 * its Candidate is marked judge-failed for the Budget, and the Lane stops with
 * `budget-exhausted`. Every judgement is stored as soon as it exists, with the
 * Rubric version; a Candidate already judged is skipped, so a re-executed step
 * doesn't call the Judge again. A failed judging leaves the Candidate's
 * Likeness, never a made-up score.
 */
export const judgeIteration = (input: LaneGenerated) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const { dataDirectory, retryPolicy } = yield* RunConfig;
    const run = yield* store.loadRun(input.runId);
    const record = yield* store.loadJudge(input.runId);
    if (!record) return yield* new RunError({ message: `Run ${input.runId} has no Judge` });
    const judge = yield* (yield* Judges).get(run.request.judge, record.price);
    if (judge.rubric.version !== record.rubricVersion) {
      return yield* new RunError({
        message: `Run ${input.runId} is judged with ${record.rubricVersion}, but this build has only ${judge.rubric.version}`,
      });
    }
    const pending = (yield* store.loadCandidates(input.runId, input.lane)).filter(
      (candidate): candidate is ScoredCandidate =>
        candidate.outcome?._tag === "Scored" &&
        candidate.judgement === null &&
        candidate.image !== null,
    );
    const finish = (budgetExhausted: boolean) =>
      Effect.gen(function* () {
        const stopReason =
          input.stopReason ?? (budgetExhausted ? "budget-exhausted" : "iteration-limit");
        yield* store.stopLane(input.runId, input.lane, stopReason);
        return { runId: input.runId, lane: input.lane, stopReason } satisfies LaneResult;
      });
    if (pending.length === 0) return yield* finish(false);

    // Everything the calls need is read before any is reserved. A step re-executed after a
    // Judge call whose judgement wasn't saved numbers its calls on.
    const references = yield* Effect.forEach(
      storedPhotos(run.photoReport, record.referencePhotos),
      (stored) => forJudge(stored.path, "image/jpeg", "Reference Photo"),
    );
    const items = yield* Effect.forEach(pending, (candidate) => {
      const path = imagePath(dataDirectory, candidate.image.sha256, candidate.image.type);
      return forJudge(path, candidate.image.type, `Candidate ${candidate.candidate}'s image`).pipe(
        Effect.map((image) => {
          const earlierCalls = candidate.calls.filter(({ purpose }) => purpose === "judge").length;
          const { runId, lane, iteration } = candidate;
          const key = { runId, lane, iteration, candidate: candidate.candidate };
          const gate = candidateGate(store, key, "judge", judge.model, earlierCalls);
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
    const notJudged = items.slice(reserved.length);
    for (const { key } of notJudged) {
      yield* store.saveJudgement(
        key,
        judgeFailed(
          judge.rubric,
          "budget-exhausted",
          "Not judged: the Judge call didn't fit the Budget",
        ),
      );
    }
    return yield* finish(
      notJudged.length > 0 ||
        judgements.some(
          (judgement) => judgement._tag === "JudgeFailed" && judgement.cause === "budget-exhausted",
        ),
    );
  });
