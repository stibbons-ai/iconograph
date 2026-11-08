import { parseArgs } from "node:util";
import {
  analysePairs,
  calibrationPairs,
  calibrationRules,
  calibrationWarnings,
  ceilingSuggestion,
  type CeilingSuggestion,
  checkCalibrationSubjects,
  type Embedding,
  FaceEmbedder,
  type FaceModelError,
  type PairSetsAnalysis,
} from "@iconograph/domain";
import { Effect, Layer, Logger } from "effect";
import {
  type CalibrationFolder,
  readCalibrationFolder,
  type SkippedEntry,
} from "./calibration-folder";
import { runCommand } from "./command";
import { resolveDataDirectory } from "./data-directory";
import { errorMessage } from "./errors";
import { OnnxFaceEmbedder } from "./face-embedder";
import { HeldOutFaceEmbedder, OnnxHeldOutFaceEmbedder } from "./held-out-embedder";
import {
  decodeReferencePhoto,
  failure,
  onPhoto,
  pixelKey,
  ReferencePhotoError,
} from "./reference-photos";

const help = `Calibrate the face models' thresholds on labelled photos of consenting Subjects

Usage:
  bun run faces:calibrate [--data-dir PATH] [--target-far RATE] FOLDER

Options:
  --data-dir PATH    Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                     Weights are read from PATH/models; SFace is fetched on
                     first use, the held-out FaceNet must be built first with
                     \`bun run models:export-facenet\`.
  --target-far RATE  False accept rate the suggested thresholds may not exceed
                     on different-person pairs, in [0, 1) (default 0.01).
  --help, -h         Show this help.

FOLDER holds one directory per consenting Subject with that Subject's real
photos (JPEG, PNG or HEIC). Optional person-labelled generated Candidates go in
SUBJECT/candidates/like/ (a person judged it shows the Subject) and
SUBJECT/candidates/unlike/ (judged not to):

  FOLDER/ada/1.jpg  FOLDER/ada/2.heic  FOLDER/ada/candidates/like/c1.png
  FOLDER/bob/1.jpg  FOLDER/bob/candidates/unlike/c2.png

Real photos are paired with the anchor of their Subject's other photos and
with each other Subject's anchor (realAnchor), and with each other photo
(real). Each Candidate pairs with its Subject's Identity Anchor
(candidateAnchor) and with each of its real photos (candidatePhoto); like is
same-person, unlike different-person. At least 2 Subjects are needed, one of
them with 2 or more photos. Hidden files are ignored and entries outside the
layout are listed as skipped; an image with no face or several faces is skipped
and reported. Any other file in a photo folder that can't be read or decoded as
an image is an error, and so is the same image twice. A backslash in FOLDER's
path or in any name in it is an error (Bun reads it as a folder separator).

Images are decoded as by photos:validate, read in place and never copied or
stored; the report names them only by their path relative to FOLDER. Git must
not be able to add any file in FOLDER or in the real folder of any image in it
(symlinks resolved): each lies outside any git working tree, or all its files
are ignored and none is tracked. So git won't pick up the photos (a forced
\`git add -f\` is not prevented).

Prints one JSON object: per face model (SFace, held-out FaceNet) and pair set,
the same- and different-person similarity distributions and FAR and FRR at
thresholds 0.20-0.90 in steps of 0.05 and at the configured one. realAnchor
and candidateAnchor, where the Identity Gate and the FaceNet threshold apply,
also give a suggested threshold and the equal error rate point; take the
thresholds from them. For SFace also the suggested single-photo Identity
Ceiling and each Subject's Ceiling. The rules behind every suggestion are in
the report. Thresholds are never changed by this command. Errors print JSON to
stderr and exit nonzero.
`;

/** Test seams: the face backends (so tests can choose where weights come from) and stdout. */
export interface CalibrateCliDependencies {
  embedders?: (
    dataDirectory: string,
  ) => Layer.Layer<FaceEmbedder | HeldOutFaceEmbedder, FaceModelError>;
  stdout?: (text: string) => void;
}

/** Paths in the report are relative to the calibration folder. */
export interface CalibrationReport {
  targetFar: number;
  rules: typeof calibrationRules;
  /** Usable images (one face) per Subject. */
  subjects: { name: string; photos: number; like: number; unlike: number }[];
  skipped: SkippedEntry[];
  models: {
    sface: PairSetsAnalysis & {
      model: string;
      configured: { identityGate: number; singlePhotoCeiling: number };
      ceiling: CeilingSuggestion;
    };
    facenet: PairSetsAnalysis & { model: string; configured: { threshold: number } };
  };
  warnings: string[];
}

/** One Subject's usable images as embedded by one model. */
type EmbeddedSubject = { name: string } & Record<"photos" | "like" | "unlike", Embedding[]>;

/**
 * Decode every image of `folder` in turn, skip those without exactly one face,
 * and embed the face with both models. Only embeddings are kept, never pixels.
 * Errors name images by their path relative to the folder.
 */
const embedFolder = (folder: CalibrationFolder) =>
  Effect.gen(function* () {
    const sface = yield* FaceEmbedder;
    const facenet = yield* HeldOutFaceEmbedder;
    const seenPixels = new Map<string, string>();
    const skipped: SkippedEntry[] = [];
    const embedded = { sface: [] as EmbeddedSubject[], facenet: [] as EmbeddedSubject[] };
    for (const { name, ...images } of folder.subjects) {
      const bySface: EmbeddedSubject = { name, photos: [], like: [], unlike: [] };
      const byFacenet: EmbeddedSubject = { name, photos: [], like: [], unlike: [] };
      for (const kind of ["photos", "like", "unlike"] as const) {
        const label = kind === "photos" ? "Photo" : "Candidate";
        for (const { resolved, shown } of images[kind]) {
          const { image } = yield* decodeReferencePhoto(resolved, undefined, label).pipe(
            Effect.mapError((error) =>
              error instanceof ReferencePhotoError
                ? failure(shown, error.message.replaceAll(resolved, shown))
                : error,
            ),
          );
          const key = pixelKey(image);
          const earlier = seenPixels.get(key);
          if (earlier !== undefined) {
            return yield* failure(shown, `Images ${earlier} and ${shown} are the same image`);
          }
          seenPixels.set(key, shown);
          const faces = yield* sface.detect(image).pipe(Effect.mapError(onPhoto(shown, label)));
          const [face] = faces;
          if (faces.length !== 1 || !face) {
            skipped.push({
              path: shown,
              reason: faces.length === 0 ? "no face" : `${faces.length} faces`,
            });
            continue;
          }
          bySface[kind].push(
            yield* sface.embed(image, face).pipe(Effect.mapError(onPhoto(shown, label))),
          );
          byFacenet[kind].push(
            yield* facenet.embed(image, face).pipe(Effect.mapError(onPhoto(shown, label))),
          );
        }
      }
      embedded.sface.push(bySface);
      embedded.facenet.push(byFacenet);
    }
    return {
      embedded,
      skipped,
      sface: { model: sface.model, thresholds: sface.thresholds },
      facenet: { model: facenet.model, threshold: facenet.threshold },
    };
  });

/** Calibrate on the folder at `root`; see `help`. `embedders` runs only once the folder passes its checks. */
async function calibrate(
  root: string,
  targetFar: number,
  embedders: () => Layer.Layer<FaceEmbedder | HeldOutFaceEmbedder, FaceModelError>,
): Promise<CalibrationReport> {
  const folder = await readCalibrationFolder(root);
  checkCalibrationSubjects(folder.subjects);
  const { embedded, skipped, sface, facenet } = await Effect.runPromise(
    embedFolder(folder).pipe(
      Effect.provide(embedders()),
      Effect.scoped,
      Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatJson)])),
    ),
  );
  const allSkipped = [...folder.skipped, ...skipped];
  // Rechecked on the photos with one face, naming what was skipped.
  try {
    checkCalibrationSubjects(embedded.sface);
  } catch (error) {
    const listed = allSkipped.map(({ path, reason }) => `${path} (${reason})`).join(", ");
    throw new Error(`${errorMessage(error)}; skipped: ${listed || "nothing"}`);
  }
  const { identityGate, singlePhotoCeiling } = sface.thresholds;
  const sfaceAnalysis = analysePairs(calibrationPairs(embedded.sface), {
    targetFar,
    configured: [identityGate],
  });
  const ceiling = ceilingSuggestion(embedded.sface);
  return {
    targetFar,
    rules: calibrationRules,
    subjects: embedded.sface.map(({ name, photos, like, unlike }) => ({
      name,
      photos: photos.length,
      like: like.length,
      unlike: unlike.length,
    })),
    skipped: allSkipped,
    models: {
      sface: {
        model: sface.model,
        configured: { identityGate, singlePhotoCeiling },
        ...sfaceAnalysis,
        ceiling,
      },
      facenet: {
        model: facenet.model,
        configured: { threshold: facenet.threshold },
        ...analysePairs(calibrationPairs(embedded.facenet), {
          targetFar,
          configured: [facenet.threshold],
        }),
      },
    },
    // Both models skip the same images, so SFace's Subjects stand for both.
    warnings: calibrationWarnings({
      subjects: embedded.sface,
      ceiling,
      analysis: sfaceAnalysis,
      configured: sface.thresholds,
    }),
  };
}

export async function main(args: string[], dependencies: CalibrateCliDependencies = {}) {
  const {
    embedders = (dataDirectory: string) =>
      Layer.mergeAll(
        OnnxFaceEmbedder({ dataDirectory }),
        OnnxHeldOutFaceEmbedder({ dataDirectory }),
      ),
    stdout = (text) => process.stdout.write(text),
  } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      "target-far": { type: "string", default: "0.01" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  if (positionals.length !== 1) {
    throw new Error(
      `Expected one calibration folder, got ${positionals.length} paths; use --help for usage`,
    );
  }
  const targetFar = Number(values["target-far"]);
  if (values["target-far"].trim() === "" || !(targetFar >= 0 && targetFar < 1)) {
    throw new Error(`--target-far expects a rate in [0, 1), got ${values["target-far"]}`);
  }
  const report = await calibrate(positionals[0]!, targetFar, () =>
    embedders(resolveDataDirectory(values["data-dir"])),
  );
  stdout(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) await runCommand(main);
