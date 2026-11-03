import {
  type CandidateKey,
  decodeReferencePhoto,
  errorMessage,
  imagePath,
  isStorableImageType,
  loadCharacterReference,
  type ReferencePhotoReport,
  RunStore,
  type RunStoreError,
  storeImage,
  validateReferencePhotos,
} from "@iconograph/adapters";
import {
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
  notSent,
  type RetryPolicy,
  type RgbImage,
  type RunRequest,
  scoreCandidate,
  selectCharacterReferences,
  toUsd,
} from "@iconograph/domain";
import { Context, Data, Effect } from "effect";
import type { EstimateEvent, LaneGenerated, LaneInput, LaneResult } from "./schemas";

/** M0 runs one Iteration per Lane; Iterations are numbered from 1. */
export const ITERATION = 1;

/** Where a Run keeps its files, and how it retries. */
export class RunConfig extends Context.Service<
  RunConfig,
  { readonly dataDirectory: string; readonly retryPolicy: RetryPolicy }
>()("@iconograph/server/RunConfig") {}

export const defaultRunConfig = (dataDirectory: string) => ({
  dataDirectory,
  retryPolicy: DEFAULT_RETRY_POLICY,
});

/** A Run that can't proceed, for a reason the operator can fix. */
export class RunError extends Data.TaggedError("RunError")<{ message: string; cause?: unknown }> {}

/**
 * The request every Candidate of a Lane's Iteration is generated from: the
 * Prompt, the Lane's character references as sent (stripped, at most 2048 px)
 * and the Lane size, which an adapter lists first among its sizes.
 */
const laneRequest = (
  photoReport: ReferencePhotoReport,
  characterReferences: readonly number[],
  prompt: string,
  model: ImageModel,
) =>
  Effect.gen(function* () {
    const storedPhotos = new Map(
      photoReport.photos.flatMap((photo) =>
        photo.verdict === "accepted" ? [[photo.photo, photo.stored] as const] : [],
      ),
    );
    const references = yield* Effect.forEach(characterReferences, (photo) =>
      loadCharacterReference(storedPhotos.get(photo)!),
    );
    return { prompt, references, size: model.capabilities.sizes[0] } satisfies ImageRequest;
  });

/**
 * Prepare a Run: get every Lane's Image Model (credentials and price, before
 * anything billable), validate the Reference Photos, freeze the Run with its
 * Identity Anchor and Ceiling, choose each Lane's character references from
 * its own accepted photos, store each Lane's initial Prompt (its own, else the
 * one built from the Target Look), and announce the estimated cost.
 */
export const prepareRun = (
  runId: string,
  request: RunRequest,
  announce: (event: EstimateEvent) => Promise<void>,
) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const imageModels = yield* ImageModels;
    const { dataDirectory } = yield* RunConfig;
    const models = yield* Effect.forEach(request.lanes, ({ model }) => imageModels.get(model));

    // The request schema already rejects two choices for one photo.
    const faceChoices = new Map(request.faceChoices.map(({ photo, face }) => [photo, face]));
    const { report, accepted } = yield* validateReferencePhotos({
      paths: request.photos,
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

    yield* store.createRun({ id: runId, request, photoReport: { ...report, identity } });
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
    yield* Effect.promise(() =>
      announce({
        event: "estimate",
        runId,
        budgetUsd: request.budgetUsd,
        estimatedUsd: toUsd(estimates.reduce((sum, { micros }) => sum + micros, 0)),
        lanes: estimates.map(({ lane, model, perCall, micros }) => ({
          lane,
          model,
          candidates: request.candidates,
          perCallUsd: toUsd(perCall),
          estimatedUsd: toUsd(micros),
        })),
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

    const reserved: CandidateKey[] = [];
    /** Log annotations naming the Candidate a warning is about. */
    const about = ({ runId, lane, iteration, candidate }: CandidateKey) =>
      Effect.annotateLogs({ runId, lane, iteration, candidate });
    // If reserving fails or is interrupted partway, the calls already reserved were never
    // sent: book each at $0, and log each one that can't be booked.
    const settleNotSent = Effect.forEach(
      reserved,
      (key) =>
        store
          .settleCall(
            { ...key, attempt: 0 },
            notSent("reserving the Lane's calls failed or was interrupted"),
          )
          .pipe(
            Effect.ignore({ log: "Warn", message: "Settling an unsent reservation failed" }),
            about(key),
          ),
      { discard: true },
    );
    yield* Effect.gen(function* () {
      for (let candidate = 0; candidate < run.request.candidates; candidate++) {
        const key = { ...iteration, candidate };
        const fits = yield* fitsBudget(
          store.reserveCall({ ...key, attempt: 0 }, model.model, estimate),
        );
        if (!fits) break;
        reserved.push(key);
      }
    }).pipe(Effect.onError(() => settleNotSent));

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
      (key) => {
        const gate: CallGate<RunStoreError> = {
          reserve: (attempt, callEstimate) =>
            store.reserveCall({ ...key, attempt }, model.model, callEstimate),
          settle: (attempt, result) => store.settleCall({ ...key, attempt }, result),
        };
        return generateCandidate({ model, request, gate, policy: retryPolicy }).pipe(
          about(key),
          Effect.tap((generation) => save(key, generation)),
        );
      },
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
 * step.
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
    const stopReason = input.stopReason ?? "iteration-limit";
    yield* store.stopLane(input.runId, input.lane, stopReason);
    return { runId: input.runId, lane: input.lane, stopReason } satisfies LaneResult;
  });
