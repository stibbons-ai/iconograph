import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY_ROOT } from "@iconograph/adapters";
import { HeldOutFaceEmbedder } from "@iconograph/adapters/held-out";
import {
  DEFAULT_TARGET_LOOK,
  DEFAULT_WEIGHTS,
  type FaceEmbedder,
  FaceModelError,
  initialPrompt,
  type Judges,
  type Optimizers,
  toUsd,
} from "@iconograph/domain";
import { readRunReport } from "@iconograph/server";
import { Effect, Layer } from "effect";
import { realFaceEmbedder, realHeldOutEmbedder } from "../../adapters/test/face-models";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import {
  FAKE_ACTUAL_MICROS,
  faceFixture,
  type FakeOptions,
  type FakeScript,
  fakeImageModels,
} from "../../server/test/support/fake-image-models";
import {
  FAKE_JUDGE_ACTUAL_MICROS,
  FAKE_VERDICT,
  fakeJudges,
  judgesOnFakeVendors,
  levels,
} from "../../server/test/support/fake-judges";
import {
  FAKE_OPTIMIZER_ACTUAL_MICROS,
  fakeOptimizers,
  optimizersOnFakeVendor,
} from "../../server/test/support/fake-optimizers";
import {
  fakeVendorServer,
  vendorAnswer,
  vendorError,
} from "../../server/test/support/fake-vendors";
import { spawnWithoutKeys } from "../../server/test/support/spawn-without-keys";
import { type EvalCliDependencies, main } from "../src/cli";
import { readSubjectsFolder } from "../src/subjects";

const temporaryDirectory = temporaryDirectories("eval");

/** Fake keys for the real Judges on fake vendor APIs. */
const KEYS = {
  ANTHROPIC_API_KEY: "sk-ant-fake-eval-test-key-000001",
  OPENAI_API_KEY: "sk-fake-eval-test-key-0000000001",
};

/** A Subjects folder with the Subjects `names` (default `biden`), each with two photos and `extra` files. */
async function subjectsFolder(extra: Record<string, string> = {}, names = ["biden"]) {
  const root = await temporaryDirectory();
  for (const name of names) {
    const subject = join(root, name);
    await mkdir(subject);
    await copyFile(faceFixture("biden-2022.jpg"), join(subject, "1.jpg"));
    await copyFile(faceFixture("biden-2021.jpg"), join(subject, "2.jpg"));
    for (const [file, content] of Object.entries(extra)) {
      await writeFile(join(subject, file), content);
    }
  }
  return root;
}

interface EvaluateOptions {
  script?: FakeScript;
  images?: FakeOptions;
  /** The Judges (both the loop's and the second): default the fake Judge. */
  judges?: Layer.Layer<Judges>;
  /** Default the fake Optimizer, its calls estimated at `optimizerEstimateMicros`. */
  optimizers?: Layer.Layer<Optimizers>;
  optimizerEstimateMicros?: number;
  faceEmbedder?: Layer.Layer<FaceEmbedder, FaceModelError>;
  heldOutEmbedder?: Layer.Layer<HeldOutFaceEmbedder, FaceModelError>;
  /** Runs with the vendors' warning callback when they are opened. */
  onVendors?: (warn: (message: string) => void) => void;
  /** Closing the vendors fails, as a secondary error after the evaluation. */
  closeFails?: boolean;
  wrapRunStoreClient?: EvalCliDependencies["wrapRunStoreClient"];
}

/** The eval CLI in process with fake vendors and the real face models; its error, if it failed. */
async function evaluate(args: string[], options: EvaluateOptions = {}) {
  const images = fakeImageModels(options.script ?? [], options.images);
  const optimizers = fakeOptimizers(
    [],
    options.optimizerEstimateMicros === undefined
      ? {}
      : { estimateMicros: options.optimizerEstimateMicros },
  );
  let stdout = "";
  const stderr: string[] = [];
  let error: unknown;
  await main(args, {
    vendors: async (_, warn) => {
      options.onVendors?.(warn);
      return {
        imageModels: images.layer,
        judges: options.judges ?? fakeJudges().layer,
        optimizers: options.optimizers ?? optimizers.layer,
        close: () => {
          if (options.closeFails) throw new Error("fake close fault");
        },
      };
    },
    faceEmbedder: () => options.faceEmbedder ?? realFaceEmbedder(),
    heldOutEmbedder: () => options.heldOutEmbedder ?? realHeldOutEmbedder(),
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
    ...(options.wrapRunStoreClient && { wrapRunStoreClient: options.wrapRunStoreClient }),
    stdout: (text) => (stdout += text),
    stderr: (text) => stderr.push(text),
  }).catch((caught: unknown) => {
    error = caught;
  });
  return { stdout, stderr, images, optimizers, error };
}

/** `evaluate`'s error message; fails the test when it didn't fail. */
async function failure(args: string[], options: EvaluateOptions = {}) {
  const { error } = await evaluate(args, options);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

const report = (out: string) => Bun.file(join(out, "report.json")).json();
const stored = (out: string, runId: string) =>
  readRunReport(join(out, "runs.db"), join(out, "data"), runId);
/** Whether nothing exists at `path`. */
const absent = (path: string) =>
  stat(path).then(
    () => false,
    (error: unknown) => (error as { code?: string }).code === "ENOENT",
  );

/**
 * The real held-out backend, whose `failingCall`th face detection (from 1)
 * fails, or (`defect`) throws while it is called, as a bug would.
 */
const faultyHeldOut = (failingCall: number, defect = false) =>
  Layer.effect(HeldOutFaceEmbedder)(
    Effect.gen(function* () {
      const real = yield* HeldOutFaceEmbedder;
      let calls = 0;
      return {
        ...real,
        detect: (image: Parameters<typeof real.detect>[0]) => {
          if (++calls !== failingCall) return real.detect(image);
          if (defect) throw new TypeError("fake bug in face detection");
          return Effect.fail(new FaceModelError({ message: "fake face-model fault" }));
        },
      };
    }),
  ).pipe(Layer.provide(realHeldOutEmbedder()));

/** Lines of `runs.jsonl`, parsed. */
const runLines = async (out: string) =>
  (await Bun.file(join(out, "runs.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const common = (out: string) => ["--out", out, "--model", "gemini", "--candidates", "1"];

describe("eval harness with fake vendors", () => {
  test("both Arms run at the same Budget; Resample resends the starting Prompt, never calls the Optimizer and runs with patience off", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    const { optimizers, error } = await evaluate(
      [...common(out), "--budget", "1", "--max-iterations", "2", "--patience", "2", subjects],
      { script: ["same", "different", "same", "different"] },
    );
    expect(error).toBeUndefined();
    const result = await report(out);
    const [optimizerRun, resampleRun] = result.runs;
    expect(
      result.runs.map(({ arm, iterations }: { arm: string; iterations: number }) => [
        arm,
        iterations,
      ]),
    ).toEqual([
      ["optimizer", 2],
      ["resample", 2],
    ]);
    expect(result).toMatchObject({
      incomplete: false,
      incompleteReason: null,
      pairs: { planned: 1, compared: 1 },
    });
    // The second Judge is another vendor's model than the loop's.
    expect(result.settings.judge.model).toBe("anthropic/claude-sonnet-5-5");
    expect(result.settings.evalJudge.model).toBe("openai/gpt-6.1-sol");

    // Both stored Runs: the same Budget; patience 3 for the Optimizer Arm, off (3 > 2) for Resample.
    const optimizerStored = await stored(out, optimizerRun.runId);
    const resampleStored = await stored(out, resampleRun.runId);
    expect([optimizerStored.totals.budgetUsd, resampleStored.totals.budgetUsd]).toEqual([1, 1]);
    expect(optimizerStored.stopRules).toMatchObject({ patience: 2, maxIterations: 2 });
    expect(resampleStored.stopRules).toMatchObject({ patience: 3, maxIterations: 2 });
    expect(result.settings.armStopRules.resample.patience).toBeGreaterThan(2);
    // The Resample Lane: the starting Prompt every Iteration, no Optimizer call.
    const start = initialPrompt(DEFAULT_TARGET_LOOK);
    expect(resampleStored.lanes[0]!.prompts.map(({ prompt, source }) => [prompt, source])).toEqual([
      [start, "initial"],
      [start, "resampled"],
    ]);
    expect(
      resampleStored.lanes[0]!.prompts.flatMap(({ optimizerCost }) => optimizerCost.calls),
    ).toEqual([]);
    expect(optimizers.requests).toHaveLength(1);

    // Every image is scored by the held-out model: the Subject passes, someone else doesn't.
    for (const run of result.runs) {
      expect(
        run.candidates.map(({ heldOut }: { heldOut: { pass: boolean } }) => heldOut.pass),
      ).toEqual([true, false]);
    }
    // Spend per Arm is the Run's own; the second Judge's is apart and adds up.
    const imageMicros = 2 * FAKE_ACTUAL_MICROS;
    const loopJudge = FAKE_JUDGE_ACTUAL_MICROS; // only the Subject's image passes the Identity Gate
    expect(resampleRun.armCost.actualUsd).toBeCloseTo(toUsd(imageMicros + loopJudge), 10);
    expect(optimizerRun.armCost.actualUsd).toBeCloseTo(
      toUsd(imageMicros + loopJudge + FAKE_OPTIMIZER_ACTUAL_MICROS),
      10,
    );
    for (const run of result.runs) {
      expect(run.evalCost.actualUsd).toBeCloseTo(toUsd(2 * FAKE_JUDGE_ACTUAL_MICROS), 10);
    }
    expect(result.totals.evalCost.actualUsd).toBeCloseTo(toUsd(4 * FAKE_JUDGE_ACTUAL_MICROS), 10);
    expect(result.totals.armCost.actualUsd).toBeCloseTo(
      optimizerRun.armCost.actualUsd + resampleRun.armCost.actualUsd,
      10,
    );
    // The loop judged only the image past the Identity Gate; the second Judge judged both.
    expect(resampleRun.candidates.map(({ loop }: { loop: object }) => loop)).toEqual([
      { judgeTotal: expect.any(Number), likeness: expect.any(Number) },
      { judgeTotal: null, likeness: null },
    ]);
    expect(
      resampleRun.candidates.map(
        ({ evalJudge }: { evalJudge: { status: string } }) => evalJudge.status,
      ),
    ).toEqual(["judged", "judged"]);
    // Each Run was written as it finished, too.
    const lines = (await Bun.file(join(out, "runs.jsonl")).text()).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).runId)).toEqual(
      result.runs.map(({ runId }: { runId: string }) => runId),
    );
  }, 120_000);

  test("where the Budget binds, both Arms stop on it within it, and Resample buys more images", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    // Each Optimizer call is reserved at $0.20: the Optimizer Arm's Budget runs out an image earlier.
    const { error } = await evaluate(
      [...common(out), "--budget", "0.5", "--max-iterations", "20", "--patience", "20", subjects],
      { script: Array<"same">(40).fill("same"), optimizerEstimateMicros: 200_000 },
    );
    expect(error).toBeUndefined();
    const [optimizerRun, resampleRun] = (await report(out)).runs;
    for (const run of [optimizerRun, resampleRun]) {
      expect(run.stopReason).toBe("budget-exhausted");
      expect(run.armCost.committedUsd).toBeLessThanOrEqual(0.5);
    }
    expect(resampleRun.candidates.length).toBeGreaterThan(optimizerRun.candidates.length);
  }, 120_000);

  test("an unreadable image is unreadable for both held-out scores and never sent; a Refused Candidate has none", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    const { error } = await evaluate(
      [...common(out), "--candidates", "2", "--max-iterations", "1", subjects],
      { script: ["garbage", "refuse", "garbage", "refuse"] },
    );
    expect(error).toBeUndefined();
    const result = await report(out);
    for (const run of result.runs) {
      expect(
        run.candidates.map(
          ({
            heldOut,
            evalJudge,
          }: {
            heldOut: { status: string } | null;
            evalJudge: { status: string } | null;
          }) => [heldOut?.status ?? null, evalJudge?.status ?? null],
        ),
      ).toEqual([
        ["unreadable", "unreadable"],
        [null, null],
      ]);
      expect(run.evalCost.actualUsd).toBe(0);
    }
    expect(result.arms.resample).toMatchObject({
      candidates: 2,
      images: 1,
      heldOut: { unreadable: 1 },
    });
  }, 120_000);

  test("a fault of the face model while scoring stops the evaluation after that Run, which keeps its spend", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    // Detections 1 and 2 are the Reference Photos; 3 is the Optimizer Arm's first image.
    const { images, stdout, error } = await evaluate(
      [...common(out), "--max-iterations", "2", subjects],
      { script: ["same", "same", "same", "same"], heldOutEmbedder: faultyHeldOut(3) },
    );
    expect((error as Error).message).toMatch(
      /Scoring the run of biden .* failed: .*fake face-model fault/,
    );
    expect(images.requests).toHaveLength(2);
    const result = await report(out);
    expect(result).toMatchObject({ incomplete: true, pairs: { planned: 1, compared: 0 } });
    expect(result.incompleteReason).toContain("fake face-model fault");
    const [run] = result.runs;
    expect(result.runs).toHaveLength(1);
    expect(run).toMatchObject({ arm: "optimizer", complete: false, candidates: [] });
    expect(run.armCost.actualUsd).toBeGreaterThan(0);
    // An unpaired Run is in the totals, never in a comparison row.
    expect(result.arms.optimizer.runs).toBe(0);
    expect(result.totals.armCost.actualUsd).toBe(run.armCost.actualUsd);
    expect(await runLines(out)).toEqual([
      expect.objectContaining({ runId: run.runId, complete: false }),
    ]);
    expect(stdout).toContain("Incomplete: Scoring the run of biden");
  }, 120_000);

  test("a failing close after an abort leaves the abort as the reason, on stderr and in the report", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    const { stderr, error } = await evaluate([...common(out), "--max-iterations", "1", subjects], {
      script: ["same", "same"],
      heldOutEmbedder: faultyHeldOut(3),
      closeFails: true,
    });
    expect((error as Error).message).toContain("fake face-model fault");
    expect(
      (error as { cleanupErrors?: Error[] }).cleanupErrors?.map(({ message }) => message),
    ).toEqual(["fake close fault"]);
    expect((await report(out)).incompleteReason).toContain("fake face-model fault");
    expect(
      stderr.map((line) => JSON.parse(line)).find(({ event }) => event === "run-aborted")?.reason,
    ).toContain("fake face-model fault");
  }, 120_000);

  test("an image the held-out decode reads but the second Judge's reader can't stops the evaluation", async () => {
    // The Subject is Obama; the Candidate is Biden in HEIC bytes labelled PNG: Gated (another
    // person), so the loop's Judge never reads it; the held-out decode reads HEIC, the Judge's
    // reader (sharp, without HEVC) can't.
    const root = await temporaryDirectory();
    await mkdir(join(root, "obama"));
    await copyFile(faceFixture("obama-2012.jpg"), join(root, "obama", "1.jpg"));
    const out = join(await temporaryDirectory(), "out");
    const { error } = await evaluate([...common(out), "--max-iterations", "1", root], {
      script: ["same", "same"],
      images: { sameImage: faceFixture("biden-2021.heic"), imageType: "image/png" },
    });
    expect((error as Error).message).toMatch(
      /Scoring the run of obama .* failed: Reading Candidate image/,
    );
    const result = await report(out);
    expect(result.incomplete).toBe(true);
    const [run] = result.runs;
    expect(run).toMatchObject({ complete: false, candidates: [] });
    expect(run.armCost.actualUsd).toBeGreaterThan(0);
  }, 120_000);

  test("a Run that can't be read back stops the evaluation with its spend unknown", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    // Once the Lane's stop is stored, reading the Run fails: only the read-back does that.
    let stopped = false;
    const { error } = await evaluate([...common(out), "--max-iterations", "1", subjects], {
      script: ["same", "same"],
      wrapRunStoreClient: (client) =>
        new Proxy(client, {
          get: (target, property) => {
            // The client keeps private fields: its methods must run on the client itself.
            const value = Reflect.get(target, property, target);
            if (property !== "execute")
              return typeof value === "function" ? value.bind(target) : value;
            return async (statement: { sql: string }) => {
              const sql = typeof statement === "string" ? statement : statement.sql;
              if (stopped && sql.startsWith("SELECT * FROM runs")) {
                throw new Error("fake read-back fault");
              }
              const result = await target.execute(statement as never);
              if (sql.includes("UPDATE lanes SET stop_reason")) stopped = true;
              return result;
            };
          },
        }),
    });
    expect((error as Error).message).toMatch(
      /Reading the run of biden .* back failed: .*fake read-back fault/,
    );
    const result = await report(out);
    expect(result.runs[0]).toMatchObject({
      complete: false,
      armCost: null,
      runId: expect.any(String),
    });
    expect(result.totals.armCost.unknownCostRuns).toBe(1);
  }, 120_000);

  test("a defect while scoring stops the evaluation too, with the Run's spend", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    const { error } = await evaluate([...common(out), "--max-iterations", "1", subjects], {
      script: ["same", "same"],
      heldOutEmbedder: faultyHeldOut(3, true),
    });
    expect((error as Error).message).toContain("fake bug in face detection");
    const [run] = (await report(out)).runs;
    expect(run).toMatchObject({ complete: false });
    expect(run.armCost.actualUsd).toBeGreaterThan(0);
  }, 120_000);

  test("a Run that fails stops the evaluation: the Runs before it are kept, no later Run starts", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    // The Resample Run on Gemini makes call 4, beyond the script: it fails; OpenAI's never start.
    const { images, error } = await evaluate(
      [
        "--out",
        out,
        "--model",
        "gemini",
        "--model",
        "openai",
        "--candidates",
        "1",
        "--max-iterations",
        "2",
        subjects,
      ],
      { script: ["same", "same", "same"] },
    );
    expect((error as Error).message).toContain("beyond its script");
    expect(images.requests).toHaveLength(4);
    const result = await report(out);
    expect(result).toMatchObject({ incomplete: true, pairs: { planned: 2, compared: 0 } });
    expect(
      result.runs.map(({ arm, complete }: { arm: string; complete: boolean }) => [arm, complete]),
    ).toEqual([
      ["optimizer", true],
      ["resample", false],
    ]);
    // Stored before it failed: what it spent is read back.
    expect(result.runs[1].runId).toEqual(expect.any(String));
    expect(result.runs[1].armCost.actualUsd).toBeGreaterThan(0);
  }, 120_000);

  test("an evaluation that stops early still warns of a flat second Judge over the images judged before", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    // Gemini's two Runs take the 10 scripted images, which the fake second Judge scores alike;
    // OpenAI's first Run calls beyond the script and stops the evaluation.
    const { stdout, error } = await evaluate(
      [
        "--out",
        out,
        "--model",
        "gemini",
        "--model",
        "openai",
        "--candidates",
        "5",
        "--max-iterations",
        "1",
        subjects,
      ],
      { script: Array<"same">(10).fill("same") },
    );
    expect((error as Error).message).toContain("beyond its script");
    const result = await report(out);
    expect(result).toMatchObject({ incomplete: true });
    const flat = result.warnings.filter(({ code }: { code: string }) => code === "eval-judge-flat");
    // Only Gemini's images were judged: one scope.
    expect(flat).toEqual([expect.objectContaining({ imageModel: null, share: 1, images: 10 })]);
    // Below the tables, before the reason the evaluation stopped.
    expect(stdout).toContain(`Warning: ${flat[0].message}\nIncomplete: `);
  }, 120_000);

  test("a Run that fails before it is stored stops the evaluation with no Run id and unknown spend", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    let gets = 0;
    // The second price lookup is the first Run's own, before it is stored.
    const { images, error } = await evaluate([...common(out), "--max-iterations", "1", subjects], {
      script: ["same", "same"],
      images: {
        beforeGet: () => {
          if (++gets === 2) throw new Error("fake lookup fault");
        },
      },
    });
    expect((error as Error).message).toContain("fake lookup fault");
    expect(images.requests).toEqual([]);
    const [run] = (await report(out)).runs;
    expect(run).toMatchObject({ runId: null, complete: false, armCost: null });
  }, 120_000);

  test("a loop Judge key turned away stops the evaluation after that Run, with an incomplete report", async () => {
    const anthropic = fakeVendorServer(() =>
      vendorError(401, "authentication_error", "invalid x-api-key"),
    );
    const openai = fakeVendorServer(() => vendorAnswer("openai", JSON.stringify(FAKE_VERDICT)));
    try {
      const subjects = await subjectsFolder();
      const out = join(await temporaryDirectory(), "out");
      const { images, stderr, error } = await evaluate(
        [...common(out), "--max-iterations", "2", subjects],
        {
          script: ["same", "same"],
          judges: judgesOnFakeVendors({ anthropic: anthropic.origin, openai: openai.origin }, KEYS),
        },
      );
      expect((error as Error).message).toMatch(
        /stopped judge-failed: .*invalid x-api-key.*rejected the loop's Judge for good/,
      );
      const result = await report(out);
      expect(result).toMatchObject({ incomplete: true });
      expect(result.incompleteReason).toContain("judge-failed");
      expect(stderr.map((line) => JSON.parse(line)).map(({ event }) => event)).toContain(
        "run-aborted",
      );
      // No further Run started: one image, the Optimizer Arm's first.
      expect(result.runs.map(({ arm }: { arm: string }) => arm)).toEqual(["optimizer"]);
      expect(images.requests).toHaveLength(1);
    } finally {
      anthropic.stop();
      openai.stop();
    }
  }, 120_000);

  test("an Optimizer turned away stops the evaluation after that Run", async () => {
    const isOptimizerRequest = (body: string) =>
      "prompt" in (JSON.parse(body).output_config?.format?.schema?.properties ?? {});
    const anthropic = fakeVendorServer((_, body) =>
      isOptimizerRequest(body)
        ? vendorError(402, "billing_error", "credit balance too low")
        : vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
    );
    try {
      const subjects = await subjectsFolder();
      const out = join(await temporaryDirectory(), "out");
      const { images, error } = await evaluate(
        [...common(out), "--max-iterations", "2", subjects],
        {
          script: ["same", "same"],
          optimizers: optimizersOnFakeVendor(anthropic.origin, "anthropic", KEYS),
        },
      );
      expect((error as Error).message).toMatch(
        /stopped optimizer-failed: .*credit balance too low/,
      );
      expect(images.requests).toHaveLength(1);
      expect((await report(out)).runs.map(({ arm }: { arm: string }) => arm)).toEqual([
        "optimizer",
      ]);
    } finally {
      anthropic.stop();
    }
  }, 120_000);

  test("a second Judge key turned away costs one call: the rest are skipped and a warning says so", async () => {
    const anthropic = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
    );
    const openai = fakeVendorServer(() =>
      Response.json(
        { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
        { status: 401 },
      ),
    );
    try {
      const subjects = await subjectsFolder();
      const out = join(await temporaryDirectory(), "out");
      const { stderr, error } = await evaluate(
        [...common(out), "--candidates", "2", "--max-iterations", "1", subjects],
        {
          script: Array<"same">(4).fill("same"),
          judges: judgesOnFakeVendors({ anthropic: anthropic.origin, openai: openai.origin }, KEYS),
        },
      );
      expect(error).toBeUndefined();
      expect(openai.requests).toHaveLength(1);
      const result = await report(out);
      expect(
        result.runs.flatMap(
          ({ candidates }: { candidates: { evalJudge: { status: string; cause?: string } }[] }) =>
            candidates.map(({ evalJudge }) => evalJudge.cause ?? evalJudge.status),
        ),
      ).toEqual(["non-recoverable", "skipped", "skipped", "skipped"]);
      expect(result.warnings.map(({ code }: { code: string }) => code)).toContain(
        "eval-judge-rejected",
      );
      expect(stderr.some((line) => line.includes("eval-judge-rejected"))).toBe(true);
    } finally {
      anthropic.stop();
      openai.stop();
    }
  }, 120_000);

  test("a second-Judge call that gives up doesn't prove its key: the next one alone meets the rejection", async () => {
    const anthropic = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
    );
    // The first image's call and its two retries are overloaded; then the key is rejected.
    let calls = 0;
    const openai = fakeVendorServer(() =>
      ++calls <= 3
        ? Response.json({ error: { message: "overloaded", type: "server_error" } }, { status: 503 })
        : Response.json(
            { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
            { status: 401 },
          ),
    );
    try {
      const subjects = await subjectsFolder();
      const out = join(await temporaryDirectory(), "out");
      const { error } = await evaluate(
        [...common(out), "--candidates", "3", "--max-iterations", "1", subjects],
        {
          script: Array<"same">(6).fill("same"),
          judges: judgesOnFakeVendors({ anthropic: anthropic.origin, openai: openai.origin }, KEYS),
        },
      );
      expect(error).toBeUndefined();
      // Three tries of the first image, one of the second; had giving up proven the key, the
      // second and third images would have gone out together.
      expect(openai.requests).toHaveLength(4);
      const [first] = (await report(out)).runs;
      expect(
        first.candidates.map(
          ({ evalJudge }: { evalJudge: { status: string; cause?: string } }) =>
            evalJudge.cause ?? evalJudge.status,
        ),
      ).toEqual(["gave-up", "non-recoverable", "skipped"]);
    } finally {
      anthropic.stop();
      openai.stop();
    }
  }, 120_000);

  test.each([
    ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5"],
    ["openai/gpt-6.1-sol", "openai/gpt-6-astra"],
  ])(
    "a second Judge from the loop Judge's vendor is refused before anything runs (%s, %s)",
    async (judge, evalJudge) => {
      const subjects = await subjectsFolder();
      const out = join(await temporaryDirectory(), "out");
      expect(
        await failure([
          "--out",
          out,
          "--judge-model",
          judge,
          "--eval-judge-model",
          evalJudge,
          subjects,
        ]),
      ).toContain("the second Judge must come from another vendor");
      expect(await absent(out)).toBe(true);
    },
  );

  test("an OpenAI loop Judge gets a Google second Judge; a second Judge from an Image Model's vendor is a warning", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    await evaluate(
      [...common(out), "--max-iterations", "1", "--judge-model", "openai/gpt-6.1-sol", subjects],
      { script: ["same", "same"] },
    );
    const google = await report(out);
    expect(google.settings.evalJudge.model).toBe("google/gemini-4-argon");
    // Gemini comes from Google, the second Judge's vendor.
    expect(google.warnings).toEqual([
      expect.objectContaining({
        code: "eval-judge-same-vendor",
        models: ["gemini-nano-banana-2.1"],
      }),
    ]);

    const openaiOut = join(await temporaryDirectory(), "out");
    await evaluate(
      [
        "--out",
        openaiOut,
        "--model",
        "openai",
        "--candidates",
        "1",
        "--max-iterations",
        "1",
        subjects,
      ],
      { script: ["same", "same"] },
    );
    expect((await report(openaiOut)).warnings.map(({ code }: { code: string }) => code)).toEqual([
      "eval-judge-same-vendor",
    ]);
  }, 120_000);

  test("an explicit older second Judge is still accepted (#50 reruns gemini-3.1-pro-preview)", async () => {
    const out = join(await temporaryDirectory(), "out");
    const subjects = await subjectsFolder();
    const result = await evaluate(
      [
        ...common(out),
        "--max-iterations",
        "1",
        "--eval-judge-model",
        "google/gemini-3.1-pro-preview",
        subjects,
      ],
      { script: ["same", "same"] },
    );
    expect(result.error).toBeUndefined();
    expect((await report(out)).settings.evalJudge.model).toBe("google/gemini-3.1-pro-preview");
  }, 120_000);

  test("an output folder or Subjects folder inside the repository is refused before anything is read or written", async () => {
    // A Subjects folder that would fail later anyway: had the guard not come first, nothing billed.
    const subjects = await temporaryDirectory();
    const inside = join(REPOSITORY_ROOT, "packages", "eval-harness", ".eval-test-out");
    expect(await failure(["--out", inside, subjects])).toContain("is inside the repository");
    expect(await absent(inside)).toBe(true);
    // Linked from outside, it is still inside.
    const link = join(await temporaryDirectory(), "link");
    await symlink(join(REPOSITORY_ROOT, "packages"), link);
    expect(await failure(["--out", join(link, "out"), subjects])).toContain(
      "is inside the repository",
    );
    expect(await absent(join(REPOSITORY_ROOT, "packages", "out"))).toBe(true);
    expect(await failure([REPOSITORY_ROOT])).toContain(
      `The Subjects folder ${REPOSITORY_ROOT.replace(/\/$/, "")} is inside the repository`,
    );
  });

  test("a non-empty output folder is refused, so no earlier eval is mixed in", async () => {
    const subjects = await subjectsFolder();
    const out = await temporaryDirectory();
    await writeFile(join(out, "report.json"), "{}");
    expect(await failure(["--out", out, subjects])).toContain("is not empty");
  });

  test("a failure before the first Run writes nothing: a new, an empty and a linked --out stay as they were", async () => {
    const anthropic = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
    );
    const openai = fakeVendorServer(() => vendorAnswer("openai", JSON.stringify(FAKE_VERDICT)));
    try {
      const subjects = await subjectsFolder();
      const origins = { anthropic: anthropic.origin, openai: openai.origin };
      const { ANTHROPIC_API_KEY } = KEYS;
      const empty = await temporaryDirectory();
      const target = await temporaryDirectory();
      const linked = join(await temporaryDirectory(), "linked");
      await symlink(target, linked);
      const fresh = join(await temporaryDirectory(), "out");
      for (const out of [fresh, empty, linked]) {
        // No OpenAI key: the second Judge's is checked before any billable call.
        const missing = await evaluate([...common(out), "--max-iterations", "1", subjects], {
          judges: judgesOnFakeVendors(origins, { ANTHROPIC_API_KEY }),
        });
        expect((missing.error as Error).message).toContain("OPENAI_API_KEY");
        expect(missing.images.requests).toEqual([]);
      }
      expect(await absent(fresh)).toBe(true);
      expect(await readdir(empty)).toEqual([]);
      expect(await readdir(linked)).toEqual([]);
      expect(await readdir(target)).toEqual([]);
      const again = await evaluate([...common(empty), "--max-iterations", "1", subjects], {
        script: ["same", "same"],
        judges: judgesOnFakeVendors(origins, KEYS),
      });
      expect(again.error).toBeUndefined();
      expect((await report(empty)).runs).toHaveLength(2);
    } finally {
      anthropic.stop();
      openai.stop();
    }
  }, 120_000);

  test("the report holds the price sources, price refresh failures and the Run engine's warnings", async () => {
    const subjects = await subjectsFolder();
    const out = join(await temporaryDirectory(), "out");
    const { error } = await evaluate([...common(out), "--max-iterations", "1", subjects], {
      script: ["same", "same"],
      onVendors: (warn) => warn("Price refresh failed: fake network down"),
      // Releasing the face backend logs a warning, as a failing release would.
      faceEmbedder: Layer.merge(
        realFaceEmbedder(),
        Layer.effectDiscard(Effect.addFinalizer(() => Effect.logWarning("fake release warning"))),
      ),
    });
    expect(error).toBeUndefined();
    const result = await report(out);
    expect(result.warnings.map(({ code }: { code: string }) => code)).toEqual(
      expect.arrayContaining(["price-refresh-failed", "run-warning"]),
    );
    expect(result.runs[0].prices.imageModel).toMatchObject({ source: "override" });
  }, 120_000);

  test("once the second Judge's vendor has answered, its calls run in parallel", async () => {
    const anthropic = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
    );
    // The first call proves the key and answers at once; every later one is held until a second
    // call is in flight beside it. A real-time deadline (not a wait: met at once when calls
    // overlap) lets scoring that stayed one at a time fail fast instead of by the test timeout.
    let calls = 0;
    let inFlight = 0;
    let serial = false;
    const overlapping = Promise.withResolvers<void>();
    const deadline = setTimeout(() => {
      serial = true;
      overlapping.resolve();
    }, 5_000);
    const openai = fakeVendorServer(async () => {
      if (++calls > 1) {
        if (++inFlight >= 2) overlapping.resolve();
        await overlapping.promise;
        inFlight--;
      }
      return vendorAnswer("openai", JSON.stringify(FAKE_VERDICT));
    });
    try {
      const subjects = await subjectsFolder();
      const out = join(await temporaryDirectory(), "out");
      const { error } = await evaluate(
        [...common(out), "--candidates", "4", "--max-iterations", "1", subjects],
        {
          script: Array<"same">(8).fill("same"),
          judges: judgesOnFakeVendors({ anthropic: anthropic.origin, openai: openai.origin }, KEYS),
        },
      );
      expect(error).toBeUndefined();
      expect(serial).toBe(false);
      expect(openai.requests).toHaveLength(8);
    } finally {
      clearTimeout(deadline);
      anthropic.stop();
      openai.stop();
    }
  }, 120_000);

  test("a second Judge that gives 10 images one score warns on stderr, in the report and below the tables; varied scores don't", async () => {
    const subjects = await subjectsFolder();
    const args = (out: string) => [
      ...common(out),
      "--candidates",
      "5",
      "--max-iterations",
      "1",
      subjects,
    ];
    // The fake second Judge gives every image every criterion at level 4: one score.
    const flatOut = join(await temporaryDirectory(), "out");
    const flat = await evaluate(args(flatOut), { script: Array<"same">(10).fill("same") });
    expect(flat.error).toBeUndefined();
    const flatReport = await report(flatOut);
    const flatWarnings = flatReport.warnings.filter(
      ({ code }: { code: string }) => code === "eval-judge-flat",
    );
    // One Image Model: the overall warning alone.
    expect(flatWarnings).toHaveLength(1);
    const [warning] = flatWarnings;
    expect(warning).toMatchObject({
      judge: "openai/gpt-6.1-sol",
      imageModel: null,
      share: 1,
      images: 10,
    });
    expect(warning.score).toBeCloseTo(flatReport.arms.optimizer.evalJudge.best, 2);
    expect(flat.stderr.map((line) => JSON.parse(line))).toContainEqual({ warning });
    expect(flat.stdout).toContain(`Warning: ${warning.message}\n`);

    const anthropic = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
    );
    // Every criterion at 1, 2, 3, 4, 5, 1, ...: no score holds 80% of the images.
    let calls = 0;
    const openai = fakeVendorServer(() =>
      vendorAnswer(
        "openai",
        JSON.stringify({
          ...FAKE_VERDICT,
          levels: levels(((calls++ % 5) + 1) as 1 | 2 | 3 | 4 | 5),
        }),
      ),
    );
    try {
      const variedOut = join(await temporaryDirectory(), "out");
      const varied = await evaluate(args(variedOut), {
        script: Array<"same">(10).fill("same"),
        judges: judgesOnFakeVendors({ anthropic: anthropic.origin, openai: openai.origin }, KEYS),
      });
      expect(varied.error).toBeUndefined();
      expect(openai.requests).toHaveLength(10);
      const variedReport = await report(variedOut);
      // Every image judged, at five different scores (2 each): none holds 80%.
      const variedScores = variedReport.runs.flatMap(
        ({ candidates }: { candidates: { evalJudge: { status: string; score?: number } }[] }) =>
          candidates.map(({ evalJudge }) => evalJudge),
      );
      expect(variedScores.map(({ status }: { status: string }) => status)).toEqual(
        Array(10).fill("judged"),
      );
      expect(new Set(variedScores.map(({ score }: { score?: number }) => score)).size).toBe(5);
      expect(variedReport.warnings.map(({ code }: { code: string }) => code)).not.toContain(
        "eval-judge-flat",
      );
      expect(varied.stderr.join("")).not.toContain("eval-judge-flat");
      expect(varied.stdout).not.toContain("Warning:");
    } finally {
      anthropic.stop();
      openai.stop();
    }
  }, 120_000);

  test("a Reference Photo that isn't accepted stops the evaluation before any Run", async () => {
    const subjects = await subjectsFolder();
    await copyFile(faceFixture("earth-apollo17.jpg"), join(subjects, "biden", "3.jpg"));
    const out = join(await temporaryDirectory(), "out");
    const { images, error } = await evaluate(["--out", out, "--model", "gemini", subjects]);
    expect((error as Error).message).toMatch(
      /Subject biden: every Reference Photo must be accepted.*3\.jpg: rejected \(no-face\)/,
    );
    expect(images.requests).toEqual([]);
    expect(await absent(out)).toBe(true);
  }, 60_000);
});

describe("Subjects folder errors", () => {
  const fails = async (extra: Record<string, string>, message: string | RegExp) => {
    const subjects = await subjectsFolder(extra);
    expect(await failure(["--out", join(await temporaryDirectory(), "out"), subjects])).toMatch(
      message,
    );
  };

  test("a look.json that isn't JSON, or names an unknown facet, whatever the case of its name", async () => {
    await fails({ "look.json": "{ pose:" }, "Subject biden: look.json is not a readable JSON file");
    await fails(
      { "look.json": '{"mood": "calm"}' },
      /Subject biden: look\.json: Expected no excess property\s+at \["mood"\]/,
    );
    await fails({ "Look.JSON": "{ pose:" }, "Subject biden: Look.JSON is not a readable JSON file");
  });

  test("faces.json naming a file that is no photo of the Subject, and an empty prompt.txt", async () => {
    await fails(
      { "faces.json": '{"9.jpg": 1}' },
      "faces.json names 9.jpg, which is not one of its photos",
    );
    await fails({ "faces.json": '{"1.jpg": 0}' }, /faces\.json \(expected/);
    await fails({ "prompt.txt": "  \n" }, "Subject biden: prompt.txt is empty");
  });

  test("a broken link is named with its Subject and file", async () => {
    const subjects = await subjectsFolder();
    await symlink(join(subjects, "nowhere.jpg"), join(subjects, "biden", "3.jpg"));
    expect(await failure(["--out", join(await temporaryDirectory(), "out"), subjects])).toContain(
      "Subject biden: 3.jpg could not be read",
    );
  });

  test("photos are numbered with numbers compared as numbers: 2.jpg before 10.jpg", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "ada"));
    for (const name of ["10.jpg", "2.jpg", "1.jpg"]) {
      await copyFile(faceFixture("biden-2022.jpg"), join(root, "ada", name));
    }
    const [ada] = await readSubjectsFolder(root);
    expect(ada!.photos.map((path) => basename(path))).toEqual(["1.jpg", "2.jpg", "10.jpg"]);
  });

  test("a Subject without photos, and a Subjects folder without Subjects", async () => {
    const root = await temporaryDirectory();
    const out = join(await temporaryDirectory(), "out");
    expect(await failure(["--out", out, root])).toContain("has no Subject folder");
    await mkdir(join(root, "ada"));
    await writeFile(join(root, "ada", "look.json"), "{}");
    expect(await failure(["--out", out, root])).toContain(
      "Subject ada has 0 Reference Photos; a Run takes 1 to 8",
    );
  });
});

const withFakes = fileURLToPath(new URL("./support/run-eval-with-fakes.ts", import.meta.url));
const runCli = fileURLToPath(new URL("../../server/src/cli.ts", import.meta.url));

// Walkthrough of the operator's command in a real process: two Subjects on two Image Models, the
// real Judges on fake Anthropic (loop) and OpenAI (second Judge) APIs, the tables on stdout and the
// JSON report, then every stored Run read back with the Run CLI's `read`.
test("walkthrough: bun run eval prints the comparison, writes the report, and its Runs read back", async () => {
  const anthropic = fakeVendorServer(() => vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)));
  // Resemblance at 5, everything else at 1: the total without Likeness is Resemblance's share of 10.
  const verdict = { ...FAKE_VERDICT, levels: { ...levels(1), resemblance: 5 } };
  const openai = fakeVendorServer(() => vendorAnswer("openai", JSON.stringify(verdict)));
  try {
    const subjects = await subjectsFolder({ "prompt.txt": "A studio headshot, navy backdrop.\n" }, [
      "ada",
      "bob",
    ]);
    const out = join(await temporaryDirectory(), "out");
    const { stdout, stderr, exitCode } = await spawnWithoutKeys(
      withFakes,
      [
        "--out",
        out,
        "--model",
        "gemini",
        "--model",
        "openai:flare",
        "--candidates",
        "1",
        "--max-iterations",
        "2",
        "--budget",
        "2",
        subjects,
      ],
      {
        FAKE_IMAGE_SCRIPT: JSON.stringify(Array(16).fill("same")),
        FAKE_ANTHROPIC_ORIGIN: anthropic.origin,
        FAKE_OPENAI_ORIGIN: openai.origin,
        ...KEYS,
      },
    );
    expect(exitCode).toBe(0);
    const events = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      event: "plan",
      runs: 8,
      budgetUsdPerRun: 2,
      armBudgetUsd: 16,
    });
    expect(events.filter(({ event }) => event === "estimate")).toHaveLength(8);
    // The tables: per Arm overall, per Image Model and per Subject, held-out and loop.
    const rows = stdout.split("\n").filter((row) => /\s+optimizer(\s|$)/.test(row));
    expect(rows).toHaveLength(2 * (1 + 2 + 4));
    expect(stdout.trim().split("\n").at(-1)).toBe(`Report: ${join(out, "report.json")}`);

    const result = await report(out);
    expect(openai.requests).toHaveLength(
      result.arms.optimizer.images + result.arms.resample.images,
    );
    const expected = (10 * DEFAULT_WEIGHTS.resemblance) / (1 - DEFAULT_WEIGHTS.likeness);
    expect(result.arms.resample.evalJudge.best).toBeCloseTo(expected, 9);
    expect(result.arms.resample.evalJudge.subjectMean).toBeCloseTo(expected, 9);
    // Its second Judge gives every image the same score: overall only, each Image Model has 8 images.
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "eval-judge-same-vendor", models: ["gpt-image-2.6-flare"] }),
      expect.objectContaining({ code: "eval-judge-flat", imageModel: null, share: 1, images: 16 }),
    ]);
    expect(stdout).toContain(`Warning: ${result.warnings[1].message}\n`);
    for (const run of result.runs) {
      const read = await spawnWithoutKeys(runCli, [
        "read",
        "--db",
        join(out, "runs.db"),
        "--data-dir",
        join(out, "data"),
        "--run-id",
        run.runId,
      ]);
      expect(read.exitCode).toBe(0);
      const runReport = JSON.parse(read.stdout);
      expect(runReport.totals.actualUsd).toBe(run.armCost.actualUsd);
      expect(runReport.lanes[0].prompts[0].prompt).toBe("A studio headshot, navy backdrop.");
      expect(runReport.lanes[0].candidates).toHaveLength(run.candidates.length);
    }
    expect(await readdir(out)).toEqual(
      expect.arrayContaining(["report.json", "runs.jsonl", "runs.db", "data"]),
    );
  } finally {
    anthropic.stop();
    openai.stop();
  }
}, 240_000);
