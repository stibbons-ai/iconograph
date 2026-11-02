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
  DEFAULT_JUDGE,
  type FaceEmbedder,
  type FaceModelError,
  GEMINI_IMAGE_MODEL,
  type ImageModels,
  type Judges,
  MAX_CANDIDATES,
  MAX_REFERENCE_PHOTOS,
  OPENAI_FLARE_IMAGE_MODEL,
  OPENAI_IMAGE_MODEL,
  type RetryPolicy,
  RunRequest,
  TargetLookInput,
} from "@iconograph/domain";
import { Effect, type Layer, Schema } from "effect";
import { createRunApplication, readRunReport } from "./index";
import { MastraJudges } from "./judge";
import { jsonLine } from "./warnings";
import { LANE_CONCURRENCY } from "./workflow";

const help = `Start a Run: one or more Lanes, up to ${LANE_CONCURRENCY} at a time, one Iteration of Candidates each, each judged

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
  --lane SPEC         One Lane per use; repeatable (default: one gemini Lane).
                      Up to ${LANE_CONCURRENCY} Lanes run at a time; more wait their turn.
                      SPEC is NAME[,photos=N+N...][,prompt=FILE]:
                        NAME     gemini (${GEMINI_IMAGE_MODEL}), openai or
                                 openai:sunburst (${OPENAI_IMAGE_MODEL}), or
                                 openai:flare (${OPENAI_FLARE_IMAGE_MODEL})
                        photos   the photo numbers (from 1) this Lane may send,
                                 e.g. photos=1+3+4 (default: all)
                        prompt   a text file with this Lane's initial Prompt
                                 (default: the Prompt built from the Target Look);
                                 last, since FILE is the rest of SPEC, commas and all
                      e.g. --lane gemini --lane openai:flare,photos=1+2,prompt=p.txt
  --pin PHOTO         Always send photo PHOTO (numbered from 1) as a character
                      reference in every Lane; it must be among each Lane's
                      photos. Repeatable; at most 4 with a Gemini Lane, 16 with
                      an OpenAI Lane.
  --face PHOTO:FACE   Use face FACE of photo PHOTO when it shows several faces,
                      as in photos:validate. Repeatable.
  --judge-model ID    The Judge, as a Mastra model router id: an anthropic/,
                      openai/ or google/ vision model (default:
                      ${DEFAULT_JUDGE.model}).
  --judge-effort LEVEL
                      The Judge's reasoning effort: low, medium or high
                      (default: ${DEFAULT_JUDGE.effort}).
  --data-dir PATH     Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data):
                      images, face-model weights and the price cache.
  --db PATH           LibSQL file for Runs (default: ./iconograph.db); its
                      directory must exist.
  --run-id ID         With read: the Run to print.
  --help, -h          Show this help.

Gemini: Google's Interactions API, 2K, store=false; needs GEMINI_API_KEY.
At most 4 character references are sent to Google.
OpenAI: the Images API edits endpoint, 1024x1024 at high quality; needs
OPENAI_API_KEY. Up to 16 character references are sent to OpenAI, which
keeps API inputs and outputs up to 30 days for abuse monitoring.
Keys are read from the environment only, never stored or logged. Each Lane
sends only its chosen character references (stripped of metadata) and its
Prompt to its vendor.

Every Candidate that passes the Identity Gate is scored by the Judge against
Rubric v1 with the default weights. The Judge needs its vendor's key in the
environment: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY
(or GOOGLE_API_KEY); keys are checked before any billable call and never stored
or logged. Only the Rubric, at most 3 Reference Photos (stripped), the
Candidate and the Target Look are sent to the Judge's vendor.

Before generating, an estimate prints as one JSON line on stderr. Every
billable call is checked against the remaining Budget first; a call that
doesn't fit isn't made and the Lane stops with "budget-exhausted". The result
is one JSON object on stdout: per Candidate its Outcome (Refused, Failed,
Gated or Scored), Likeness, reason, stored image and estimated and actual
cost, and its judgement (Resemblance, per-criterion scores, weighted total,
Disputed, Rubric version, issues, suggested Prompt fixes) with the Judge's
cost; each Lane's initial Prompt and stop reason; the Judge; totals; the Run's
warnings (code judge-same-vendor when the Judge's vendor makes a Lane's Image
Model); the Reference Photo warnings. read
prints the same report for a stored Run. Errors print JSON to stderr (the
last line) and exit nonzero.
`;

/** The Image Models and Judges a Run uses, and how to release what they hold. */
export interface VendorsResource {
  imageModels: Layer.Layer<ImageModels>;
  judges: Layer.Layer<Judges>;
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

/** The native Image Model adapters and the Mastra Judges, priced by the price source in the data volume. */
async function nativeVendors(
  dataDirectory: string,
  warn: (message: string) => void,
): Promise<VendorsResource> {
  const source = await openPriceSource({ dataDirectory });
  const prices = refreshOnFirstLookup(source, warn);
  return {
    imageModels: NativeImageModels({ prices }),
    judges: MastraJudges({ prices }),
    close: () => source.close(),
  };
}

/**
 * Test seam: the Image Models, Judges and face backend. Production uses the
 * native adapters and Mastra Judges with the price source and the locked ONNX
 * models; nothing in the environment can switch to a fake.
 */
export interface RunCliDependencies {
  vendors?: (dataDirectory: string, warn: (message: string) => void) => Promise<VendorsResource>;
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

/** Lane names `--lane` takes, by the Image Model each drives. */
const laneModels: Record<string, string> = {
  gemini: GEMINI_IMAGE_MODEL,
  openai: OPENAI_IMAGE_MODEL,
  "openai:sunburst": OPENAI_IMAGE_MODEL,
  "openai:flare": OPENAI_FLARE_IMAGE_MODEL,
};

/**
 * One `--lane NAME[,photos=N+N...][,prompt=FILE]`; the request schema checks the rest.
 * `prompt=` comes last: its FILE is the rest of the spec, so a path may hold commas.
 */
async function readLane(spec: string) {
  const promptAt = spec.indexOf(",prompt=");
  const head = promptAt === -1 ? spec : spec.slice(0, promptAt);
  const [name = "", ...settings] = head.split(",");
  if (!Object.hasOwn(laneModels, name)) {
    throw new Error(
      `--lane ${spec}: unknown Lane ${name}; use one of ${Object.keys(laneModels).join(", ")}`,
    );
  }
  const lane: { model: string; photos?: number[]; prompt?: string } = {
    model: laneModels[name]!,
  };
  for (const setting of settings) {
    const [key, value = ""] = setting.split(/=(.*)/s);
    if (key !== "photos" || lane.photos !== undefined) {
      throw new Error(
        `--lane ${spec}: expected photos=N+N... (at most once), then optionally prompt=FILE last`,
      );
    }
    lane.photos = value.split("+").map((photo) => parseNumber(`--lane ${spec} photos`, photo));
  }
  if (promptAt !== -1) {
    const path = spec.slice(promptAt + ",prompt=".length);
    try {
      lane.prompt = (await Bun.file(path).text()).trim();
    } catch (error) {
      const hint = path.includes(",photos=") ? " (photos= must come before prompt=)" : "";
      throw new Error(
        `--lane ${spec}: prompt ${path} is not a readable file${hint}: ${errorMessage(error)}`,
      );
    }
  }
  return lane;
}

export async function main(args: string[], dependencies: RunCliDependencies = {}) {
  const {
    vendors = nativeVendors,
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
      lane: { type: "string", multiple: true },
      pin: { type: "string", multiple: true },
      face: { type: "string", multiple: true },
      "judge-model": { type: "string" },
      "judge-effort": { type: "string" },
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
    const runOptions = [
      "budget",
      "candidates",
      "look",
      "lane",
      "pin",
      "face",
      "judge-model",
      "judge-effort",
    ] as const;
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
    lanes:
      values.lane === undefined
        ? [{ model: GEMINI_IMAGE_MODEL }]
        : await Promise.all(values.lane.map(readLane)),
    judge: {
      model: values["judge-model"] ?? DEFAULT_JUDGE.model,
      effort: values["judge-effort"] ?? DEFAULT_JUDGE.effort,
      weights: DEFAULT_JUDGE.weights,
    },
  });
  const printLine = (value: unknown) => stderr(jsonLine(value));
  const models = await vendors(dataDirectory, (warning) => printLine({ warning }));
  await withCleanup(
    async () => {
      const application = await createRunApplication({
        databasePath: values.db,
        dataDirectory,
        imageModels: models.imageModels,
        judges: models.judges,
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
