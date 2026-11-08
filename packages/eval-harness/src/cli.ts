import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  attachCleanupError,
  decodeOption,
  errorMessage,
  LANE_IMAGE_MODELS,
  laneImageModel,
  OnnxFaceEmbedder,
  resolveDataDirectory,
  RUN_SETTING_OPTIONS,
  runCommand,
  runSettingsInput,
} from "@iconograph/adapters";
import { type HeldOutFaceEmbedder, OnnxHeldOutFaceEmbedder } from "@iconograph/adapters/held-out";
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_CANDIDATES,
  DEFAULT_JUDGE,
  DEFAULT_OPTIMIZER,
  DEFAULT_STOP_RULES,
  Effort,
  type FaceEmbedder,
  type FaceModelError,
  JudgeConfig,
  llmVendor,
  MAX_CANDIDATES,
  MAX_ITERATIONS,
  MAX_REFERENCE_PHOTOS,
  OptimizerConfig,
  pricingSpec,
  type RetryPolicy,
  sameVendorLanes,
  StopRules,
} from "@iconograph/domain";
import { nativeVendors, type OpenVendors, type RunApplicationOptions } from "@iconograph/server";
import { type Layer, Schema } from "effect";
import { ARMS, type ArmRun } from "./arms";
import { armStopRules, type EvalSettings, type EvalWarning, runArms } from "./evaluate";
import {
  checkOutputFolder,
  createOutputFolder,
  outputLayout,
  refuseInsideRepository,
} from "./folders";
import { judgeOnlyWeights } from "./scoring";
import {
  compareArms,
  FLAT_JUDGE_MIN_IMAGES,
  FLAT_JUDGE_SHARE,
  flatJudgeWarnings,
  renderComparison,
} from "./report";
import { FACES_FILE, LOOK_FILE, PROMPT_FILE, readSubjectsFolder } from "./subjects";

/**
 * The second Judge by default: the first of these from another vendor than the
 * loop's Judge. The OpenAI and Google choices accept every `Effort` level
 * (`low`/`medium`/`high`; checked 2026-11-08): gpt-6.1-sol's
 * `reasoning.effort` takes `low`, `medium`, `high`, `xhigh` and `max`, no
 * `none` (https://developers.openai.com/api/docs/models/gpt-6.1-sol);
 * gemini-4-argon thinks at `low`, `medium` or `high`
 * (https://aistudio.google.com/docs/models/gemini-4-argon). The Anthropic
 * choice is unchanged in #52.
 */
const EVAL_JUDGE_CHOICES = [
  "openai/gpt-6.1-sol",
  "google/gemini-4-argon",
  "anthropic/claude-sonnet-5-5",
] as const;
const DEFAULT_MODELS = ["gemini", "openai"] as const;

const help = `Compare the Optimizer loop with resampling the starting Prompt, at equal Budget, per Subject and Image Model

Usage:
  bun run eval [options] SUBJECTS

Run by hand only: every Run makes real, billed calls to the Image Models, the
Judge and the Optimizer, and the second Judge scores every image on top. About
(Subjects × Image Models × 2 Arms) × --budget goes to the Arms (a call that
costs more than its estimate can overshoot a Run's Budget); the second Judge's
spend is outside that Budget and reported separately.

SUBJECTS is a folder with one folder per consenting Subject, outside this
repository:
  SUBJECTS/NAME/*             1 to ${MAX_REFERENCE_PHOTOS} Reference Photos (JPEG, PNG or HEIC), numbered
                              in name order, numbers compared as numbers (2.jpg
                              before 10.jpg); validated as by photos:validate,
                              and every one must be accepted
  SUBJECTS/NAME/${LOOK_FILE}     optional Target Look, as --look of bun run run
  SUBJECTS/NAME/${PROMPT_FILE}    optional starting Prompt of both Arms (default:
                              the Prompt built from the Target Look)
  SUBJECTS/NAME/${FACES_FILE}    optional face choices {"PHOTO FILE": FACE, ...} for
                              photos showing several faces, faces from 1 as in
                              photos:validate
Settings files match without case (Look.json is look.json); hidden entries are
ignored.

Arms, one Run each per Subject and Image Model, with the same Budget, Candidates
per Iteration and Judge:
  optimizer   the normal Run: the Optimizer rewrites the Prompt between Iterations
  resample    the starting Prompt every Iteration, no Optimizer call, and patience
              off (set above --max-iterations; a fixed Prompt never tries to
              improve; at --max-iterations 50 it can only be 50, which can only
              fire in the last Iteration); when the Budget, not the Iteration
              limit, ends its Runs, what the Optimizer would have cost buys
              more images
Every other stopping rule is the same for both. Compare each Arm's images and
spend beside its scores; only complete pairs (both Arms of a Subject and Image
Model) are compared.

Options:
  --out DIR           Output folder, new or empty, outside this repository,
                      created only once every check that costs nothing passed
                      and never removed: the Runs' database (runs.db), their
                      images (data/), each evaluated Run as it finishes
                      (runs.jsonl) and the report (report.json) (default:
                      SUBJECTS/.eval-TIMESTAMP).
  --model NAME        An Image Model, repeatable: ${Object.keys(LANE_IMAGE_MODELS).join(", ")}
                      (default: ${DEFAULT_MODELS.join(" and ")}).
  --budget USD        Each Run's Budget (default: ${DEFAULT_BUDGET_USD}).
  --candidates N      Candidates per Iteration, 1 to ${MAX_CANDIDATES} (default: ${DEFAULT_CANDIDATES}).
  --judge-model ID    The loop's Judge, as bun run run (default: ${DEFAULT_JUDGE.model}).
  --judge-effort LEVEL
                      low, medium or high (default: ${DEFAULT_JUDGE.effort}).
  --optimizer-model ID
                      The Optimizer (default: ${DEFAULT_OPTIMIZER.model}).
  --optimizer-effort LEVEL
                      low, medium or high (default: ${DEFAULT_OPTIMIZER.effort}).
  --target-score N, --patience N, --min-improvement N, --max-iterations N
                      The stopping rules, as bun run run (defaults:
                      ${DEFAULT_STOP_RULES.targetScore}, ${DEFAULT_STOP_RULES.patience}, ${DEFAULT_STOP_RULES.minImprovement}, ${DEFAULT_STOP_RULES.maxIterations}; at most ${MAX_ITERATIONS} Iterations);
                      --patience applies to the Optimizer Arm only.
  --eval-judge-model ID
                      The second Judge, which scores every image of both Arms
                      against the same Rubric; it must come from another vendor
                      than the loop's Judge (default: the first of
                      ${EVAL_JUDGE_CHOICES.join(", ")} that does).
  --eval-judge-effort LEVEL
                      low, medium or high (default: low).
  --data-dir PATH     Where the face-model weights are (default:
                      ICONOGRAPH_DATA_DIR, else ./.data); the held-out FaceNet
                      must be built first (bun run models:export-facenet).
  --help, -h          Show this help.

Keys come from the environment, as for bun run run: ICONOGRAPH_GEMINI_API_KEY,
ICONOGRAPH_OPENAI_API_KEY, and the Judges' and Optimizer's vendors'
(ICONOGRAPH_ANTHROPIC_API_KEY, ICONOGRAPH_OPENAI_API_KEY,
ICONOGRAPH_GEMINI_API_KEY). Both Judges' keys and prices, every Image Model's
and, unless --max-iterations is 1, the Optimizer's are checked, the photos
validated and the face models loaded before the first billable call and before
anything is written to the output folder.

The evaluation fails fast. A vendor's answer about one image (refused, failed,
no face, unusable) is a score; anything else stops the evaluation after that
Run: a Run that fails or can't be read back, a fault while scoring (the face
models, a file), and a Run the vendor stopped because it rejected the loop's
Judge or Optimizer for good (HTTP 401, 402, 403 or 404: its key, its model or
the account's credit). A second Judge rejected that way is stopped instead:
the rest of the images are skipped by it.

Every Candidate with an image, of both Arms, is scored twice outside the loop:
by the held-out FaceNet (its best face's similarity to the anchor of the
Subject's Reference Photos, and whether it reaches the threshold; no face is
counted, never averaged in) and by the second Judge (the Rubric's weighted
total without Likeness). The loop's own scores (its Judge's weighted total,
SFace Likeness) are reported separately, never mixed in.

Progress, each Run's estimate and warnings print as JSON lines on stderr. The
comparison prints as tables on stdout: per Arm the images, the best and mean
held-out scores (per image, per Subject and per Run's best), the Arm's and the
evaluation's spend, then the loop's own scores; overall, per Image Model and per
Subject; below them a line per warning that the second Judge's scores are flat
(eval-judge-flat: at least ${FLAT_JUDGE_SHARE * 100}% of at least ${FLAT_JUDGE_MIN_IMAGES} judged images, overall or
of one Image Model, at one score). report.json holds the settings, every Run
and Candidate and the warnings; once a Run has started it is always written,
with incomplete and incompleteReason when the evaluation stopped early. Errors
print JSON to stderr (the last line) and exit nonzero.
`;

/**
 * Test seam: the vendors, the face backends and the retry policy. Production
 * uses the native adapters, the Mastra Judges and Optimizers and the locked
 * ONNX models; nothing in the environment can switch to a fake.
 */
export interface EvalCliDependencies {
  vendors?: OpenVendors;
  faceEmbedder?: (weightsDirectory: string) => Layer.Layer<FaceEmbedder, FaceModelError>;
  heldOutEmbedder?: (weightsDirectory: string) => Layer.Layer<HeldOutFaceEmbedder, FaceModelError>;
  retryPolicy?: RetryPolicy;
  wrapRunStoreClient?: RunApplicationOptions["wrapRunStoreClient"];
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** The second Judge's model and effort; another vendor's model than the loop Judge's. */
function evalJudgeOption(
  values: { "eval-judge-model"?: string; "eval-judge-effort"?: string },
  judgeModel: string,
) {
  const loopVendor = llmVendor(judgeModel);
  const model =
    values["eval-judge-model"] ??
    EVAL_JUDGE_CHOICES.find((choice) => llmVendor(choice) !== loopVendor)!;
  if (llmVendor(model) === loopVendor) {
    throw new Error(
      `--eval-judge-model ${model} comes from ${loopVendor}, the loop Judge's vendor; the second Judge must come from another vendor`,
    );
  }
  return {
    model,
    effort: decodeOption(
      "--eval-judge-effort",
      Schema.decodeUnknownSync(Effort),
      values["eval-judge-effort"] ?? "low",
    ),
  };
}

export async function main(args: string[], dependencies: EvalCliDependencies = {}) {
  const {
    vendors = nativeVendors,
    faceEmbedder = (weightsDirectory: string) =>
      OnnxFaceEmbedder({ dataDirectory: weightsDirectory }),
    heldOutEmbedder = (weightsDirectory: string) =>
      OnnxHeldOutFaceEmbedder({ dataDirectory: weightsDirectory }),
    retryPolicy,
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
  } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      ...RUN_SETTING_OPTIONS,
      out: { type: "string" },
      model: { type: "string", multiple: true },
      "eval-judge-model": { type: "string" },
      "eval-judge-effort": { type: "string" },
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  if (positionals.length !== 1) {
    throw new Error(
      `Expected one Subjects folder, got ${positionals.length} paths; use --help for usage`,
    );
  }
  const subjectsFolder = resolve(positionals[0]!);
  const output = outputLayout(
    resolve(
      values.out ?? join(subjectsFolder, `.eval-${new Date().toISOString().replaceAll(":", "-")}`),
    ),
  );
  await refuseInsideRepository(subjectsFolder, "The Subjects folder");
  await refuseInsideRepository(output.folder, "The output folder");

  const models = (values.model ?? [...DEFAULT_MODELS]).map((name) =>
    laneImageModel(name, `--model ${name}`),
  );
  const repeated = models.find((model, index) => models.indexOf(model) !== index);
  if (repeated !== undefined) throw new Error(`--model names ${repeated} twice`);

  const input = runSettingsInput(values);
  const judge = decodeOption(
    "--judge-model/--judge-effort",
    Schema.decodeUnknownSync(JudgeConfig),
    input.judge,
  );
  const settings: EvalSettings = {
    models,
    budgetUsd: input.budgetUsd,
    candidates: input.candidates,
    judge,
    optimizer: decodeOption(
      "--optimizer-model/--optimizer-effort",
      Schema.decodeUnknownSync(OptimizerConfig),
      input.optimizer,
    ),
    stopRules: decodeOption(
      "The stopping rules",
      Schema.decodeUnknownSync(StopRules),
      input.stopRules,
    ),
    evalJudge: evalJudgeOption(values, judge.model),
  };

  await checkOutputFolder(output.folder);
  const subjects = await readSubjectsFolder(subjectsFolder);
  const printLine = (value: object) => stderr(`${JSON.stringify(value)}\n`);
  const warnings: EvalWarning[] = [];
  const warn = (warning: EvalWarning) => {
    warnings.push(warning);
    printLine({ warning });
  };
  const planned = subjects.length * models.length;
  printLine({
    event: "plan",
    subjects: subjects.map(({ name }) => name),
    models,
    arms: ARMS,
    runs: planned * ARMS.length,
    budgetUsdPerRun: settings.budgetUsd,
    armBudgetUsd: planned * ARMS.length * settings.budgetUsd,
    outputFolder: output.folder,
  });
  // A second Judge may favour images of its own vendor's Image Models.
  const sameVendor = sameVendorLanes(
    settings.evalJudge.model,
    models.map((model) => pricingSpec(model).mode),
  ).map((index) => models[index]!);
  if (sameVendor.length > 0) {
    warn({
      code: "eval-judge-same-vendor",
      message: `The second Judge ${settings.evalJudge.model} comes from the vendor of ${sameVendor.join(", ")}; it may favour that vendor's images`,
      models: sameVendor,
    });
  }

  // The free checks write only to a scratch folder (prices, stripped photos): the output folder
  // is created once they have all passed, and is never removed.
  const scratch = await mkdtemp(join(tmpdir(), "iconograph-eval-"));
  const armRuns: ArmRun[] = [];
  let ready = false;
  /** What stopped the evaluation (an abort or a fault); later errors are attached to it. */
  let failure: unknown;
  /** Errors after an evaluation that finished: reported, then thrown, never marking it incomplete. */
  const afterwards: unknown[] = [];
  const secondary = (error: unknown) =>
    failure === undefined ? afterwards.push(error) : attachCleanupError(failure, error);
  try {
    const resource = await vendors(scratch, (message) =>
      warn({ code: "price-refresh-failed", message }),
    );
    try {
      await runArms(subjects, settings, {
        vendors: resource,
        faceEmbedder: faceEmbedder(resolveDataDirectory(values["data-dir"])),
        heldOutEmbedder: heldOutEmbedder(resolveDataDirectory(values["data-dir"])),
        output,
        scratch,
        ...(retryPolicy && { retryPolicy }),
        ...(dependencies.wrapRunStoreClient && {
          wrapRunStoreClient: dependencies.wrapRunStoreClient,
        }),
        progress: printLine,
        warn,
        onReady: async () => {
          await createOutputFolder(output);
          ready = true;
        },
        onRun: async (run) => {
          armRuns.push(run);
          // One append of the whole line, so a line is never interleaved or split by us.
          await appendFile(output.runs, `${JSON.stringify(run)}\n`);
        },
      });
    } catch (error) {
      failure = error;
    }
    await Promise.resolve()
      .then(() => resource.close())
      .catch(secondary);
  } catch (error) {
    failure = error;
  }
  // The scratch folder holds only copies and a price cache: failing to remove it is a warning.
  await rm(scratch, { recursive: true, force: true }).catch((error: unknown) =>
    warn({
      code: "scratch-cleanup-failed",
      message: `The scratch folder ${scratch} could not be removed: ${errorMessage(error)}`,
    }),
  );
  // Nothing was billed or written to the output folder: there is no report to write.
  if (!ready) throw failure;

  const incompleteReason = failure === undefined ? null : errorMessage(failure);
  try {
    const flatJudge = flatJudgeWarnings(armRuns, settings.evalJudge.model);
    for (const warning of flatJudge) warn(warning);
    const flatJudgeLines = flatJudge.map(({ message }) => `Warning: ${message}\n`).join("");
    const comparison = compareArms(armRuns, planned);
    await Bun.write(
      output.report,
      `${JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          incomplete: incompleteReason !== null,
          incompleteReason,
          subjectsFolder,
          outputFolder: output.folder,
          database: output.database,
          settings: {
            ...settings,
            armStopRules: armStopRules(settings.stopRules),
            evalJudgeWeights: judgeOnlyWeights(settings.judge.weights),
          },
          ...comparison,
          runs: armRuns,
          warnings,
        },
        null,
        2,
      )}\n`,
    );
    stdout(
      `${renderComparison(comparison, settings.evalJudge.model)}${flatJudgeLines}${incompleteReason === null ? "" : `Incomplete: ${incompleteReason}\n`}Report: ${output.report}\n`,
    );
  } catch (error) {
    // The fault that stopped the evaluation stays the error; reporting it failed too.
    if (failure === undefined) throw error;
    attachCleanupError(failure, error);
  }
  if (failure !== undefined) throw failure;
  if (afterwards.length > 0) throw afterwards[0];
}

if (import.meta.main) await runCommand(main);
