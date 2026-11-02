import { parseArgs } from "node:util";
import {
  errorLine,
  errorMessage,
  faceChoiceMap,
  NativeImageModels,
  OnnxFaceEmbedder,
  openPriceSource,
  type PriceSource,
  resolveDataDirectory,
  withCleanup,
} from "@iconograph/adapters";
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_CANDIDATES,
  type FaceEmbedder,
  type FaceModelError,
  GEMINI_IMAGE_MODEL,
  type ImageModels,
  MAX_CANDIDATES,
  MAX_REFERENCE_PHOTOS,
  type RetryPolicy,
  RunRequest,
  TargetLookInput,
} from "@iconograph/domain";
import { Effect, type Layer, Schema } from "effect";
import { createRunApplication, readRunReport } from "./index";
import { jsonLine } from "./warnings";

const help = `Start a Run: one Gemini Lane, one Iteration of Candidates

Usage:
  bun run run [options] PHOTO...          1 to ${MAX_REFERENCE_PHOTOS} Reference Photos of the Subject
  bun run run read [--db PATH] [--data-dir PATH] --run-id ID

Options:
  --budget USD        Hard spending limit for the Run (default: ${DEFAULT_BUDGET_USD}).
  --candidates N      Candidates per Iteration, 1 to ${MAX_CANDIDATES} (default: ${DEFAULT_CANDIDATES}).
  --look FILE         Target Look as a JSON file with any of the facets pose,
                      background, lighting (lighting and colour), hairstyle,
                      clothing, framing; each a text. Missing facets take their
                      defaults; hairstyle defaults to "as in the Reference Photos".
  --pin PHOTO         Always send photo PHOTO (numbered from 1) as a character
                      reference. Repeatable; at most 4 for Gemini.
  --face PHOTO:FACE   Use face FACE of photo PHOTO when it shows several faces,
                      as in photos:validate. Repeatable.
  --data-dir PATH     Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data):
                      images, face-model weights and the price cache.
  --db PATH           LibSQL file for Runs (default: ./iconograph.db); its
                      directory must exist.
  --run-id ID         With read: the Run to print.
  --help, -h          Show this help.

The Image Model is ${GEMINI_IMAGE_MODEL} through Google's Interactions API, 2K,
with store=false; it needs GEMINI_API_KEY in the environment (never stored or
logged). Only the chosen character references (at most 4, stripped of
metadata) and the Prompt are sent to Google.

Before generating, an estimate prints as one JSON line on stderr. Every
billable call is checked against the remaining Budget first; a call that
doesn't fit isn't made and the Lane stops with "budget-exhausted". The result
is one JSON object on stdout: per Candidate its Outcome (Refused, Failed,
Gated or Scored), Likeness, reason, stored image and estimated and actual
cost; the Lane's stop reason; totals; the Reference Photo warnings. read
prints the same report for a stored Run. Errors print JSON to stderr (the
last line) and exit nonzero.
`;

/** The Image Models a Run uses, and how to release what they hold. */
export interface ImageModelsResource {
  layer: Layer.Layer<ImageModels>;
  close(): void;
}

/**
 * A price lookup that refreshes the LiteLLM data once, on the first lookup.
 * Image Models look up a price only after the API key check, so a missing key
 * fails without any network request. A failed refresh keeps the cached or
 * bundled prices (the report names the source) and is reported through `warn`.
 */
export function refreshOnFirstLookup(
  prices: Pick<PriceSource, "ensureFresh" | "lookup">,
  warn: (message: string) => void,
): Pick<PriceSource, "lookup"> {
  let refreshed: Promise<void> | undefined;
  const refreshOnce = () =>
    (refreshed ??= prices.ensureFresh().then(
      () => undefined,
      (error: unknown) => warn(`Price refresh failed: ${errorMessage(error)}`),
    ));
  return {
    lookup: (model) => Effect.promise(refreshOnce).pipe(Effect.flatMap(() => prices.lookup(model))),
  };
}

/** The native adapters, priced by the price source in the data volume. */
async function nativeImageModels(
  dataDirectory: string,
  warn: (message: string) => void,
): Promise<ImageModelsResource> {
  const prices = await openPriceSource({ dataDirectory });
  return {
    layer: NativeImageModels({ prices: refreshOnFirstLookup(prices, warn) }),
    close: () => prices.close(),
  };
}

/**
 * Test seam: the Image Models and face backend. Production uses the native
 * adapters with the price source and the locked ONNX models; nothing in the
 * environment can switch to a fake.
 */
export interface RunCliDependencies {
  imageModels?: (
    dataDirectory: string,
    warn: (message: string) => void,
  ) => Promise<ImageModelsResource>;
  faceEmbedder?: (dataDirectory: string) => Layer.Layer<FaceEmbedder, FaceModelError>;
  retryPolicy?: RetryPolicy;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function parseNumber(option: string, value: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number)) {
    throw new Error(`${option} expects a number, got ${value}`);
  }
  return number;
}

const decodeLook = Schema.decodeUnknownSync(TargetLookInput, { onExcessProperty: "error" });
const decodeRequest = Schema.decodeUnknownSync(RunRequest);

async function readLook(path: string | undefined) {
  if (path === undefined) return decodeLook({});
  let json: unknown;
  try {
    json = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    throw new Error(`--look ${path} is not a readable JSON file: ${errorMessage(error)}`);
  }
  try {
    return decodeLook(json);
  } catch (error) {
    throw new Error(`--look ${path}: ${errorMessage(error)}`);
  }
}

export async function main(args: string[], dependencies: RunCliDependencies = {}) {
  const {
    imageModels = nativeImageModels,
    faceEmbedder = (dataDirectory: string) => OnnxFaceEmbedder({ dataDirectory }),
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
  } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      budget: { type: "string" },
      candidates: { type: "string" },
      look: { type: "string" },
      pin: { type: "string", multiple: true },
      face: { type: "string", multiple: true },
      "data-dir": { type: "string" },
      db: { type: "string", default: "./iconograph.db" },
      "run-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  const reading = positionals[0] === "read";
  if (reading) {
    const runOptions = ["budget", "candidates", "look", "pin", "face"] as const;
    if (
      positionals.length > 1 ||
      values["run-id"] === undefined ||
      runOptions.some((name) => values[name])
    ) {
      throw new Error("read takes only --run-id ID, --db and --data-dir; use --help for usage");
    }
  } else if (values["run-id"] !== undefined) {
    throw new Error("--run-id is only for read; use --help for usage");
  }
  const dataDirectory = resolveDataDirectory(values["data-dir"]);
  if (reading) {
    stdout(`${JSON.stringify(await readRunReport(values.db, dataDirectory, values["run-id"]!))}\n`);
    return;
  }
  const faceChoices = faceChoiceMap(values.face ?? []);
  const request = decodeRequest({
    photos: positionals,
    faceChoices: [...faceChoices].map(([photo, face]) => ({ photo, face })),
    pins: (values.pin ?? []).map((pin) => parseNumber("--pin", pin)),
    targetLook: await readLook(values.look),
    budgetUsd:
      values.budget === undefined ? DEFAULT_BUDGET_USD : parseNumber("--budget", values.budget),
    candidates:
      values.candidates === undefined
        ? DEFAULT_CANDIDATES
        : parseNumber("--candidates", values.candidates),
    lanes: [{ model: GEMINI_IMAGE_MODEL }],
  });
  const printLine = (value: unknown) => stderr(jsonLine(value));
  const models = await imageModels(dataDirectory, (warning) => printLine({ warning }));
  await withCleanup(
    async () => {
      const application = await createRunApplication({
        databasePath: values.db,
        dataDirectory,
        imageModels: models.layer,
        faceEmbedder: faceEmbedder(dataDirectory),
        ...(dependencies.retryPolicy && { retryPolicy: dependencies.retryPolicy }),
        warn: printLine,
      });
      await withCleanup(
        async () => {
          const { runId } = await application.start(request, printLine);
          stdout(`${JSON.stringify(await application.report(runId))}\n`);
        },
        () => application.close(),
      );
    },
    () => models.close(),
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(errorLine(error));
    process.exitCode = 1;
  }
}
