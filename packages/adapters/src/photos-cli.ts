import { parseArgs } from "node:util";
import { type FaceEmbedder, type FaceModelError, MAX_REFERENCE_PHOTOS } from "@iconograph/domain";
import { Effect, type Layer, Logger } from "effect";
import { resolveDataDirectory } from "./data-directory";
import { errorLine } from "./errors";
import { OnnxFaceEmbedder } from "./face-embedder";
import { validateReferencePhotos } from "./reference-photos";

const help = `Validate 1 to ${MAX_REFERENCE_PHOTOS} Reference Photos of one Subject

Usage:
  bun run photos:validate [--data-dir PATH] [--face PHOTO:FACE]... PHOTO...

Options:
  --data-dir PATH    Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                     Accepted photos are stored in PATH/images; face-model
                     weights are read from (or fetched into) PATH/models.
  --face PHOTO:FACE  Use face FACE of photo PHOTO (both numbered from 1, as
                     printed) when a photo shows several faces. Repeatable.
  --help, -h         Show this help.

Accepts JPEG, PNG and HEIC up to 50 MiB and 50 megapixels (see the README for
why, and downscale larger photos first). Every photo is fully decoded; JPEG and
PNG corruption is rejected, HEIC corruption detection is best-effort. The same
file twice, or a photo with a usable face whose pixels repeat an earlier one, is
an error. Prints one JSON object: a verdict per photo (accepted, rejected
with no face, choice-required with the faces found, or flagged as not the same
person), the Identity Anchor (normalised mean embedding), the Identity Ceiling
and warnings. Accepted photos are re-encoded without EXIF/GPS/XMP/IPTC metadata
and stored by SHA-256. Errors print JSON to stderr and exit nonzero; warnings
logged while running (e.g. a failed model release) print JSON to stderr.
`;

/** Test seam: the face backend, so tests can choose where weights come from. */
export interface PhotosCliDependencies {
  embedder?: (dataDirectory: string) => Layer.Layer<FaceEmbedder, FaceModelError>;
  stdout?: (text: string) => void;
}

function parseFaceChoices(values: readonly string[]): Map<number, number> {
  const choices = new Map<number, number>();
  for (const value of values) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(value);
    if (!match) throw new Error(`--face expects PHOTO:FACE numbered from 1, got ${value}`);
    const photo = Number(match[1]);
    if (choices.has(photo)) throw new Error(`--face given twice for photo ${photo}`);
    choices.set(photo, Number(match[2]));
  }
  return choices;
}

export async function main(args: string[], dependencies: PhotosCliDependencies = {}) {
  const {
    embedder = (dataDirectory: string) => OnnxFaceEmbedder({ dataDirectory }),
    stdout = (text) => process.stdout.write(text),
  } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      face: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  if (positionals.length < 1 || positionals.length > MAX_REFERENCE_PHOTOS) {
    throw new Error(
      `Expected 1 to ${MAX_REFERENCE_PHOTOS} photo paths, got ${positionals.length}; use --help for usage`,
    );
  }
  const faceChoices = parseFaceChoices(values.face ?? []);
  const dataDirectory = resolveDataDirectory(values["data-dir"]);
  const report = await Effect.runPromise(
    validateReferencePhotos({ paths: positionals, faceChoices, dataDirectory }).pipe(
      Effect.provide(embedder(dataDirectory)),
      Effect.scoped,
      // Warnings (e.g. a failed model release) go to stderr as JSON, never into the report.
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
