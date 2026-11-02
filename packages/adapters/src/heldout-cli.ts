import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type FaceModelError, MAX_REFERENCE_PHOTOS } from "@iconograph/domain";
import { Effect, type Layer, Logger } from "effect";
import { resolveDataDirectory } from "./data-directory";
import { errorLine } from "./errors";
import { HeldOutFaceEmbedder, OnnxHeldOutFaceEmbedder, scoreHeldOut } from "./held-out-embedder";
import {
  checkReferenceSet,
  chooseFace,
  decodeReferencePhoto,
  type FaceSummary,
  faceChoiceMap,
  failure,
  onPhoto,
  pixelKey,
  summarize,
} from "./reference-photos";

const help = `Score a Candidate against 1 to ${MAX_REFERENCE_PHOTOS} Reference Photos with the held-out face model

Usage:
  bun run faces:heldout [--data-dir PATH] [--candidate-face FACE] [--face PHOTO:FACE]...
                        CANDIDATE REFERENCE...

Options:
  --data-dir PATH        Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                         Weights are read from PATH/models; the FaceNet ONNX must
                         be built first with \`bun run models:export-facenet\`.
  --candidate-face FACE  Use face FACE (from 1, as listed in the error) of the
                         Candidate when it shows several faces.
  --face PHOTO:FACE      Use face FACE of Reference Photo PHOTO (both from 1, in
                         the order given) when it shows several faces. Repeatable.
  --help, -h             Show this help.

The held-out model (FaceNet, ADR-0008) is never used by the Optimizer loop; this
command is how a finalist's Likeness is confirmed against it. Photos are decoded
and checked as by photos:validate and nothing is stored. The Candidate given
again as a Reference Photo, or any two images with identical pixels, is an
error. Each image needs one face (or a chosen one). Prints one JSON object: the
model, the threshold, the Candidate's similarity to each Reference Photo, its
similarity to the held-out anchor (normalised mean of the reference embeddings)
and whether that reaches the threshold. Errors print JSON to stderr and exit
nonzero.
`;

/** Test seam: the held-out backend, so tests can choose where weights come from. */
export interface HeldOutCliDependencies {
  embedder?: (dataDirectory: string) => Layer.Layer<HeldOutFaceEmbedder, FaceModelError>;
  stdout?: (text: string) => void;
}

export interface HeldOutReport {
  model: string;
  threshold: number;
  candidate: { path: string; face: FaceSummary };
  references: { photo: number; path: string; face: FaceSummary; similarity: number }[];
  /** Similarity of the Candidate to the held-out anchor of the references. */
  anchorSimilarity: number;
  pass: boolean;
}

/**
 * Decode one image, reject pixels already seen (`seenPixels`: pixel key → the
 * earlier image and its label), choose its face as photos:validate does, and
 * embed it.
 */
const embedPhoto = (
  path: string,
  choice: number | undefined,
  label: string,
  seenPixels: Map<string, { path: string; label: string }>,
) =>
  Effect.gen(function* () {
    const embedder = yield* HeldOutFaceEmbedder;
    const { image } = yield* decodeReferencePhoto(path, undefined, label);
    // A repeated image would score ≈1 against itself or vote twice in the anchor.
    const key = pixelKey(image);
    const earlier = seenPixels.get(key);
    if (earlier !== undefined) {
      return yield* failure(
        path,
        earlier.label === "Candidate"
          ? `The Candidate ${earlier.path} and Reference Photo ${path} are the same image`
          : `Reference Photos ${earlier.path} and ${path} are the same image`,
      );
    }
    seenPixels.set(key, { path, label });
    const faces = yield* embedder.detect(image).pipe(Effect.mapError(onPhoto(path, label)));
    const number = yield* chooseFace(path, faces, choice);
    if (number === undefined) {
      const listed = JSON.stringify(faces.map((face, index) => summarize(face, index + 1)));
      return yield* failure(
        path,
        faces.length === 0
          ? `${label} ${path} shows no face`
          : `${label} ${path} shows ${faces.length} faces; choose one (numbered from 1, highest score first): ${listed}`,
      );
    }
    const face = faces[number - 1]!;
    const embedding = yield* embedder
      .embed(image, face)
      .pipe(Effect.mapError(onPhoto(path, label)));
    return { face: summarize(face, number), embedding };
  });

const scoreCandidate = (options: {
  candidate: string;
  references: readonly string[];
  candidateFace?: number;
  faceChoices: ReadonlyMap<number, number>;
}) =>
  Effect.gen(function* () {
    const { candidate, references, candidateFace, faceChoices } = options;
    yield* checkReferenceSet(references, faceChoices);
    const same = references.find((reference) => resolve(reference) === resolve(candidate));
    if (same !== undefined) {
      return yield* failure(
        candidate,
        `The Candidate ${candidate} and Reference Photo ${same} are the same file`,
      );
    }
    const embedder = yield* HeldOutFaceEmbedder;
    const seenPixels = new Map<string, { path: string; label: string }>();
    const scored = yield* embedPhoto(candidate, candidateFace, "Candidate", seenPixels);
    const photos = yield* Effect.forEach(references, (path, index) =>
      embedPhoto(path, faceChoices.get(index + 1), "Reference Photo", seenPixels),
    );
    const score = scoreHeldOut(
      scored.embedding,
      photos.map(({ embedding }) => embedding),
      embedder.threshold,
    );
    return {
      model: embedder.model,
      threshold: embedder.threshold,
      candidate: { path: candidate, face: scored.face },
      references: photos.map(({ face }, index) => ({
        photo: index + 1,
        path: references[index]!,
        face,
        similarity: score.similarities[index]!,
      })),
      anchorSimilarity: score.anchorSimilarity,
      pass: score.pass,
    } satisfies HeldOutReport;
  });

export async function main(args: string[], dependencies: HeldOutCliDependencies = {}) {
  const {
    embedder = (dataDirectory: string) => OnnxHeldOutFaceEmbedder({ dataDirectory }),
    stdout = (text) => process.stdout.write(text),
  } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      "candidate-face": { type: "string" },
      face: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  const [candidate, ...references] = positionals;
  if (!candidate || references.length < 1 || references.length > MAX_REFERENCE_PHOTOS) {
    throw new Error(
      `Expected a Candidate and 1 to ${MAX_REFERENCE_PHOTOS} Reference Photo paths, got ${positionals.length} paths; use --help for usage`,
    );
  }
  const candidateFace = values["candidate-face"];
  if (candidateFace !== undefined && !/^[1-9]\d*$/.test(candidateFace)) {
    throw new Error(`--candidate-face expects a face number from 1, got ${candidateFace}`);
  }
  const faceChoices = faceChoiceMap(values.face ?? []);
  const dataDirectory = resolveDataDirectory(values["data-dir"]);
  const report = await Effect.runPromise(
    scoreCandidate({
      candidate,
      references,
      faceChoices,
      ...(candidateFace !== undefined && { candidateFace: Number(candidateFace) }),
    }).pipe(
      Effect.provide(embedder(dataDirectory)),
      Effect.scoped,
      Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson)])),
    ),
  );
  stdout(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(errorLine(error));
    process.exitCode = 1;
  }
}
