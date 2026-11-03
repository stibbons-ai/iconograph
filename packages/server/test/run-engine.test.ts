import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  errorLine,
  imagePath,
  LibsqlRunStore,
  NativeImageModels,
  readImageAtMost,
  RunStore,
} from "@iconograph/adapters";
import {
  DEFAULT_JUDGE,
  DEFAULT_OPTIMIZER,
  DEFAULT_STOP_RULES,
  DEFAULT_TARGET_LOOK,
  type EncodedImage,
  GEMINI_IMAGE_MODEL,
  type ImageModels,
  initialPrompt,
  JUDGE_IMAGE_MAX_SIDE,
  MAX_PROMPT_LENGTH,
  type Judges,
  OPENAI_IMAGE_MODEL,
  type Optimizers,
  type PriceQuote,
  type RunRequest,
} from "@iconograph/domain";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { realFaceEmbedder } from "../../adapters/test/face-models";
import { enlargedFixture, imageSize } from "../../adapters/test/large-images";
import { geminiTestPrice as price, recordedGemini } from "../../adapters/test/gemini-fixtures";
import {
  openaiTestPrice as openaiPrice,
  recordedOpenAI,
} from "../../adapters/test/openai-fixtures";
import { withEnvironment } from "../../adapters/test/git-environment";
import { tamper } from "../../adapters/test/tamper";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import { until } from "../../adapters/test/until";
import { createRunApplication, type EstimateEvent, readRunReport, type RunWarning } from "../src";
import { runReport } from "../src/report";
import {
  defaultRunConfig,
  generateIteration,
  judgeIteration,
  RunConfig,
  runIteration,
} from "../src/run-steps";
import { MastraOptimizers } from "../src/optimizer";
import type { LaneState } from "../src/schemas";
import { LANE_CONCURRENCY } from "../src/workflow";
import {
  FAKE_ACTUAL_MICROS,
  FAKE_ESTIMATE_MICROS,
  faceFixture,
  type FakeOptions,
  type FakeScript,
  fakeImageModels,
  subjectPhotos,
} from "./support/fake-image-models";
import {
  FAKE_JUDGE_ACTUAL_MICROS,
  FAKE_JUDGE_ESTIMATE_MICROS,
  type FakeJudgeOptions,
  type FakeJudgeResponse,
  FAKE_JUDGE_PRICING,
  FAKE_VERDICT,
  fakeJudges,
  fakeLlmPrice,
  levels,
} from "./support/fake-judges";
import {
  FAKE_OPTIMIZER_ACTUAL_MICROS,
  FAKE_OPTIMIZER_ESTIMATE_MICROS,
  type FakeOptimizerOptions,
  type FakeOptimizerResponse,
  fakeOptimizers,
  optimizersOnFakeAnthropic,
} from "./support/fake-optimizers";
import { fakeVendorServer, vendorAnswer } from "./support/fake-vendors";

const temporaryDirectory = temporaryDirectories("run");

/** A Run request; one Iteration per Lane unless `stopRules` says otherwise. */
const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  photos: subjectPhotos,
  faceChoices: [],
  pins: [],
  targetLook: DEFAULT_TARGET_LOOK,
  budgetUsd: 5,
  candidates: 3,
  lanes: [{ model: "gemini-nano-banana-2.1" }],
  judge: DEFAULT_JUDGE,
  optimizer: DEFAULT_OPTIMIZER,
  stopRules: { ...DEFAULT_STOP_RULES, maxIterations: 1 },
  ...overrides,
});

/** Lane 0 at its first Iteration, as the steps of a one-Lane Gemini Run see it. */
const lane0Iteration1 = (runId: string): LaneState => ({
  runId,
  lane: 0,
  model: "gemini-nano-banana-2.1",
  iteration: 1,
  stopReason: null,
});

type Report = Awaited<
  ReturnType<Awaited<ReturnType<typeof runApplication>>["application"]["report"]>
>;

/**
 * What a Run's calls commit against its Budget: each call's actual cost once
 * known, else its estimate (as the ledger counts them).
 */
const committedUsd = (report: Report) =>
  report.lanes
    .flatMap((lane) => [
      ...lane.candidates.flatMap((candidate) => [...candidate.calls, ...candidate.judgeCost.calls]),
      ...lane.prompts.flatMap((prompt) => prompt.optimizerCost.calls),
    ])
    .concat(report.unattributedCalls)
    .reduce(
      (sum, call) =>
        sum + (call.settled && call.actualUsd !== null ? call.actualUsd : call.estimatedUsd),
      0,
    );

/** Root reads and writes through any permission, so chmod-based faults can't be staged. */
const asRoot = process.getuid?.() === 0;

/** A Run application on a fresh database and data volume. */
async function runApplication(
  imageModels: Layer.Layer<ImageModels>,
  warn?: (warning: RunWarning) => void,
  judges: Layer.Layer<Judges> = fakeJudges().layer,
  optimizers: Layer.Layer<Optimizers> = fakeOptimizers().layer,
) {
  const directory = await temporaryDirectory();
  const dataDirectory = join(directory, "data");
  const databasePath = join(directory, "runs.db");
  const app = await createRunApplication({
    databasePath,
    dataDirectory,
    imageModels,
    judges,
    optimizers,
    faceEmbedder: realFaceEmbedder(),
    // The fixture photos live in the repository, outside the data volume.
    photoPaths: "operator",
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
    ...(warn && { warn }),
  });
  return { application: app, dataDirectory, databasePath };
}

/** The same, with the fake Image Model, the fake Judge and the fake Optimizer. */
async function setup(
  script: FakeScript,
  options: FakeOptions = {},
  warn?: (warning: RunWarning) => void,
  judgeScript: readonly FakeJudgeResponse[] = [],
  judgeOptions: FakeJudgeOptions = {},
  optimizerScript: readonly FakeOptimizerResponse[] = [],
  optimizerOptions: FakeOptimizerOptions = {},
) {
  const fake = fakeImageModels(script, options);
  const judge = fakeJudges(judgeScript, judgeOptions);
  const optimizer = fakeOptimizers(optimizerScript, optimizerOptions);
  return {
    ...(await runApplication(fake.layer, warn, judge.layer, optimizer.layer)),
    fake,
    judge,
    optimizer,
  };
}

/** The Lanes' stop reasons as stored (not as the report derives them). */
const storedStopReasons = (databasePath: string, runId: string) => {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db
      .query<{ stop_reason: string | null }, [string]>(
        "SELECT stop_reason FROM lanes WHERE run_id = ? ORDER BY lane",
      )
      .all(runId)
      .map(({ stop_reason }) => stop_reason);
  } finally {
    db.close();
  }
};

describe("Run engine with a fake Image Model", () => {
  test("records each Candidate Outcome with Likeness, reasons, files and costs", async () => {
    const { application, fake } = await setup(["same", "different", "no-face", "refuse", "fail"]);
    try {
      const events: unknown[] = [];
      const result = await application.start(request({ candidates: 5 }), (event) =>
        events.push(event),
      );
      expect(result.lanes).toEqual([
        {
          runId: result.runId,
          lane: 0,
          stopReason: "iteration-limit",
          iterations: 1,
          best: { iteration: 1, candidate: 0, score: expect.any(Number) },
        },
      ]);
      // The estimate came before any call: N first calls at the per-call estimate, and a
      // Judge call for each of them.
      expect(events).toEqual([
        expect.objectContaining({
          event: "estimate",
          estimatedUsd: 0.55,
          budgetUsd: 5,
          judge: expect.objectContaining({
            model: DEFAULT_JUDGE.model,
            calls: 5,
            perCallUsd: 0.01,
          }),
        }),
      ]);
      expect(fake.requests).toHaveLength(5);
      // Every call carried the frozen Target Look's Prompt and both accepted photos as references.
      for (const sent of fake.requests) {
        expect(sent.prompt).toContain(DEFAULT_TARGET_LOOK.clothing);
        expect(sent.references).toHaveLength(2);
        expect(sent.size).toBe("2K");
      }

      const report = await application.report(result.runId);
      const [lane] = report.lanes;
      expect(lane!.stopReason).toBe("iteration-limit");
      const byIndex = lane!.candidates;
      expect(byIndex.map(({ outcome }) => outcome)).toEqual([
        "Scored",
        "Gated",
        "Gated",
        "Refused",
        "Failed",
      ]);
      const [scored, gated] = byIndex;
      if (scored?.outcome !== "Scored" || gated?.outcome !== "Gated") throw new Error("unexpected");
      expect(scored.likeness).toBeGreaterThan(0);
      expect(scored.likeness).toBeLessThanOrEqual(10);
      expect(gated.reason).toBe("below-gate");
      expect(gated.similarity).toBeLessThan(report.identity.gate);
      expect(byIndex[2]).toMatchObject({ reason: "no-face", similarity: null });
      expect(byIndex[3]).toMatchObject({ reason: "safety: blocked by the fake", image: null });
      expect(byIndex[4]).toMatchObject({ reason: "fake HTTP 400: bad request", image: null });

      // Generated images are content-addressed files; refusals and failures have none.
      for (const candidate of byIndex.slice(0, 3)) {
        const bytes = await readFile(candidate.image!.path);
        expect(basename(candidate.image!.path)).toBe(
          `${Bun.CryptoHasher.hash("sha256", bytes, "hex")}.jpg`,
        );
        expect(candidate.image!.sha256).toBe(Bun.CryptoHasher.hash("sha256", bytes, "hex"));
      }
      // One cost record per billable call, with the estimate and the actual cost.
      for (const candidate of byIndex) {
        expect(candidate.calls).toHaveLength(1);
        expect(candidate.calls[0]!.estimatedUsd).toBe(FAKE_ESTIMATE_MICROS / 1e6);
      }
      expect(byIndex[0]!.calls[0]!.actualUsd).toBe(FAKE_ACTUAL_MICROS / 1e6);
      expect(byIndex[3]!.calls[0]!).toMatchObject({ result: "refused", actualUsd: 0 });
      // Only the Scored Candidate was judged; the totals count its Judge call too.
      const spent = 3 * FAKE_ACTUAL_MICROS + FAKE_JUDGE_ACTUAL_MICROS;
      expect(report.totals).toMatchObject({
        estimatedUsd: (5 * FAKE_ESTIMATE_MICROS + FAKE_JUDGE_ESTIMATE_MICROS) / 1e6,
        actualUsd: spent / 1e6,
        unknownCostCalls: 0,
        remainingUsd: 5 - spent / 1e6,
      });
      expect(report.referencePhotos.warnings.map(({ code }) => code)).toEqual(["few-photos"]);
      expect([...lane!.characterReferences].sort()).toEqual([1, 2]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("step outputs and the persisted snapshot carry ids, not image bytes or embeddings, over several Iterations", async () => {
    const { application } = await setup(["same", "same", "same"]);
    try {
      const { runId } = await application.start(
        request({ candidates: 1, stopRules: { ...DEFAULT_STOP_RULES, maxIterations: 3 } }),
      );
      const snapshot = await application.snapshot(runId);
      const steps = snapshot.context as Record<string, { output?: unknown }>;
      expect(steps.prepare?.output).toEqual([
        { runId, lane: 0, model: "gemini-nano-banana-2.1", iteration: 1, stopReason: null },
      ]);
      expect(steps.finish?.output).toEqual({
        runId,
        lanes: [
          {
            runId,
            lane: 0,
            stopReason: "iteration-limit",
            iterations: 3,
            best: { iteration: 1, candidate: 0, score: expect.any(Number) },
          },
        ],
      });
      const text = JSON.stringify(snapshot);
      // No base64 image payloads (JPEG starts /9j/), no 128-d embedding arrays, and no Prompts.
      expect(text).not.toContain("/9j/");
      expect(text).not.toMatch(/\[(-?\d+\.\d+,){100,}/);
      expect(text).not.toContain("Prompt 1");
      expect(text.length).toBeLessThan(20_000);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Budget too small for all Candidates makes only the calls that fit, never more", async () => {
    // $0.25 fits two $0.10 estimates, not three.
    const { application, fake } = await setup(["same", "same", "same"]);
    try {
      const { runId, lanes } = await application.start(request({ budgetUsd: 0.25 }));
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      expect(fake.requests).toHaveLength(2);
      const report = await application.report(runId);
      // The third Candidate's call didn't fit: stored Failed, with no call.
      expect(report.lanes[0]!.candidates.map(({ calls }) => calls.length)).toEqual([1, 1, 0]);
      expect(report.lanes[0]!.candidates[2]).toMatchObject({
        outcome: "Failed",
        budgetExhausted: true,
      });
      expect(report.totals.estimatedUsd).toBeLessThanOrEqual(0.25);
      expect(report.lanes[0]!.stopReason).toBe("budget-exhausted");
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a transient error is retried, each retry a reserved billable call", async () => {
    const { application, fake } = await setup(["transient", "transient", "same"]);
    try {
      const { runId } = await application.start(request({ candidates: 1 }));
      expect(fake.requests).toHaveLength(3);
      const [candidate] = (await application.report(runId)).lanes[0]!.candidates;
      expect(candidate!.outcome).toBe("Scored");
      expect(candidate!.calls.map(({ attempt, result }) => [attempt, result])).toEqual([
        [0, "transient"],
        [1, "transient"],
        [2, "image"],
      ]);
      expect(candidate!.estimatedUsd).toBeCloseTo((3 * FAKE_ESTIMATE_MICROS) / 1e6, 10);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("after two retries a transient error is Failed", async () => {
    const { application, fake } = await setup(["transient", "transient", "transient"]);
    try {
      const { runId, lanes } = await application.start(request({ candidates: 1 }));
      expect(fake.requests).toHaveLength(3);
      expect(lanes[0]!.stopReason).toBe("iteration-limit");
      const [candidate] = (await application.report(runId)).lanes[0]!.candidates;
      expect(candidate).toMatchObject({
        outcome: "Failed",
        reason: expect.stringContaining("gave up after 3"),
      });
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a retry that doesn't fit the Budget isn't made and stops the Lane", async () => {
    // The first call's cost is unknown (no response), so it counts at its $0.10 estimate.
    const { application, fake } = await setup(["transient", "same"], { transientCost: null });
    try {
      const { runId, lanes } = await application.start(request({ candidates: 1, budgetUsd: 0.15 }));
      expect(fake.requests).toHaveLength(1);
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      const report = await application.report(runId);
      expect(report.lanes[0]!.candidates[0]).toMatchObject({
        outcome: "Failed",
        reason: expect.stringContaining("retry not made: Budget exhausted"),
        unknownCostCalls: 1,
      });
      expect(report.totals.remainingUsd).toBeCloseTo(0.05, 10);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("an unpriced model, unusable photos or too many pins fail the Run before any call", async () => {
    const unpriced = await setup(["same"], { unpriced: true });
    try {
      await expect(unpriced.application.start(request())).rejects.toThrow("No price for model");
      expect(unpriced.fake.requests).toHaveLength(0);
    } finally {
      await unpriced.application.close();
    }
    const { application, fake } = await setup(["same"]);
    try {
      await expect(
        application.start(request({ photos: [faceFixture("earth-apollo17.jpg")] })),
      ).rejects.toThrow("No Reference Photo was accepted");
      await expect(application.start(request({ pins: [1, 2, 3, 4, 5] }))).rejects.toThrow(
        "5 photos pinned",
      );
      await expect(application.start(request({ pins: [3] }))).rejects.toThrow("Pinned photo 3");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("parallel retries race for the last Budget slot: exactly the calls that fit are made", async () => {
    // $0.40 fits 4 calls at $0.10. Three first calls fail transiently at unknown cost (each
    // counts its $0.10), so their three retries race for the one remaining slot.
    const { application, fake } = await setup(["transient", "transient", "transient", "same"], {
      transientCost: null,
    });
    try {
      const { runId, lanes } = await application.start(request({ budgetUsd: 0.4 }));
      expect(fake.requests).toHaveLength(4);
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      const report = await application.report(runId);
      expect(committedUsd(report)).toBeLessThanOrEqual(0.4);
      expect(report.lanes[0]!.candidates.map(({ outcome }) => outcome).sort()).toEqual([
        "Failed",
        "Failed",
        "Scored",
      ]);
      const failed = report.lanes[0]!.candidates.filter(({ outcome }) => outcome === "Failed");
      for (const candidate of failed) {
        expect(candidate).toMatchObject({ reason: expect.stringContaining("retry not made") });
      }
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Budget below one call makes no call, stops the Lane and reports why", async () => {
    const { application, fake } = await setup(["same"]);
    try {
      const { runId, lanes } = await application.start(request({ budgetUsd: 0.05 }));
      expect(fake.requests).toHaveLength(0);
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      const report = await application.report(runId);
      const failed = expect.objectContaining({
        outcome: "Failed",
        budgetExhausted: true,
        calls: [],
      });
      expect(report.lanes[0]!.candidates).toEqual(
        Array.from({ length: report.candidatesPerIteration }, () => failed),
      );
      expect(report.totals).toMatchObject({ estimatedUsd: 0, actualUsd: 0, remainingUsd: 0.05 });
    } finally {
      await application.close();
    }
  }, 60_000);

  test("an image of an unsupported type, or bytes that aren't an image, fail only that Candidate", async () => {
    const webp = await setup(["same"], { imageType: "image/webp" });
    try {
      const { runId } = await webp.application.start(request({ candidates: 1 }));
      const [candidate] = (await webp.application.report(runId)).lanes[0]!.candidates;
      expect(candidate).toMatchObject({
        outcome: "Failed",
        reason: "The image's type image/webp is not supported",
        image: null,
      });
    } finally {
      await webp.application.close();
    }
    const garbage = await setup(["garbage"]);
    try {
      const { runId } = await garbage.application.start(request({ candidates: 1 }));
      const [candidate] = (await garbage.application.report(runId)).lanes[0]!.candidates;
      expect(candidate).toMatchObject({
        outcome: "Failed",
        reason: expect.stringContaining("The Candidate image could not be decoded"),
      });
    } finally {
      await garbage.application.close();
    }
  }, 60_000);

  test.each([
    ["books the calls already reserved as never sent, at $0", false],
    ["warns, naming the Candidate, when such a call can't be booked", true],
  ])(
    "when reserving fails partway, the engine %s",
    async (_, blockSettle) => {
      const warnings: RunWarning[] = [];
      let databasePath = "";
      const app = await setup(
        ["same", "same"],
        {
          // At generation (the get with the recorded price), Candidate 1 can no longer be
          // reserved; in the variant, Candidate 0's reservation can't be settled either.
          beforeGet: (recorded) => {
            if (!recorded) return;
            tamper(
              databasePath,
              `CREATE TRIGGER block_reserve_1 BEFORE INSERT ON cost_records
             WHEN NEW.candidate = 1 BEGIN SELECT RAISE(ABORT, 'reserve blocked'); END`,
            );
            if (blockSettle) {
              tamper(
                databasePath,
                `CREATE TRIGGER block_settle_0 BEFORE UPDATE ON cost_records
               WHEN NEW.candidate = 0 BEGIN SELECT RAISE(ABORT, 'settle blocked'); END`,
              );
            }
          },
        },
        (warning) => warnings.push(warning),
      );
      databasePath = app.databasePath;
      try {
        const error = await app.application
          .start(request({ candidates: 2 }))
          .catch((failure: unknown) => failure);
        const { runId, error: message } = JSON.parse(errorLine(error));
        expect(message).toContain("reserve blocked");
        expect(app.fake.requests).toHaveLength(0);
        const [call] = (await app.application.report(runId)).unattributedCalls;
        if (!blockSettle) {
          expect(warnings).toEqual([]);
          // A failed Run isn't a cancelled one: its unstopped Lane keeps no stop reason.
          expect(storedStopReasons(databasePath, runId)).toEqual([null]);
          expect(call).toMatchObject({
            candidate: 0,
            settled: true,
            result: "failed",
            reason: "Not sent: reserving the Lane's calls failed or was interrupted",
            actualUsd: 0,
          });
        } else {
          expect(warnings).toEqual([
            expect.objectContaining({
              level: "Warn",
              warning: "Settling an unsent reservation failed",
              runId,
              lane: 0,
              iteration: 1,
              candidate: 0,
              cause: expect.stringContaining("settle blocked"),
            }),
          ]);
          expect(call).toMatchObject({ candidate: 0, settled: false });
        }
      } finally {
        await app.application.close();
      }
    },
    60_000,
  );

  test("a failed Run whose storage can't be checked still names its runId, marked unverified", async () => {
    let databasePath = "";
    const app = await setup(["same"], {
      // The stored Run becomes unreadable mid-Run: scoring fails, and so does the lookup after.
      beforeAnswer: async () => tamper(databasePath, "UPDATE runs SET photo_report = '{}'"),
    });
    databasePath = app.databasePath;
    try {
      const error = await app.application
        .start(request({ candidates: 1 }))
        .catch((failure: unknown) => failure);
      const line = JSON.parse(errorLine(error));
      expect(line.runId).toBeString();
      expect(line.error).toContain(`whether Run ${line.runId} was stored is unverified`);
    } finally {
      await app.application.close();
    }
  }, 60_000);

  test.skipIf(asRoot)(
    "a disk fault fails the Run with its cause and runId; read still totals every billed call",
    async () => {
      let images = "";
      const { application, dataDirectory, fake } = await setup(["same"], {
        // The image store becomes read-only after the Reference Photos were stored.
        beforeAnswer: async () => {
          images = join(dataDirectory, "images");
          await chmod(images, 0o500);
        },
      });
      try {
        const error = await application.start(request({ candidates: 1 })).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(fake.requests).toHaveLength(1);
        expect(error).toBeInstanceOf(Error);
        const line = JSON.parse(errorLine(error));
        expect(line.error).toContain("Storing Candidate 0's image failed");
        expect(line.error).toMatch(/EACCES|permission denied/i);
        expect(line.runId).toBeString();
        const report = await application.report(line.runId);
        // The billed call has no Candidate row, but still counts.
        expect(report.lanes[0]!.candidates).toEqual([]);
        expect(report.unattributedCalls).toEqual([
          expect.objectContaining({
            candidate: 0,
            result: "image",
            actualUsd: FAKE_ACTUAL_MICROS / 1e6,
          }),
        ]);
        expect(report.totals).toMatchObject({
          actualUsd: FAKE_ACTUAL_MICROS / 1e6,
          remainingUsd: 5 - FAKE_ACTUAL_MICROS / 1e6,
        });
      } finally {
        if (images) await chmod(images, 0o700);
        await application.close();
      }
    },
    60_000,
  );

  test.skipIf(asRoot)(
    "a disk fault interrupts a sibling call in flight, which still counts at its estimate",
    async () => {
      let images = "";
      const { application, dataDirectory, fake } = await setup(["same", "same"], {
        // Candidate 0's answer finds the image store read-only; Candidate 1's call never ends.
        beforeAnswer: async (call) => {
          if (call === 1) return new Promise<void>(() => {});
          images = join(dataDirectory, "images");
          await chmod(images, 0o500);
        },
      });
      try {
        const error = await application.start(request({ candidates: 2 })).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(fake.requests).toHaveLength(2);
        const line = JSON.parse(errorLine(error));
        expect(line.error).toContain("Storing Candidate 0's image failed");
        expect(line.runId).toBeString();
        const report = await application.report(line.runId);
        expect(report.unattributedCalls).toEqual([
          expect.objectContaining({ candidate: 0, result: "image", settled: true }),
          expect.objectContaining({
            candidate: 1,
            settled: true,
            result: "transient",
            reason: "Interrupted before the call finished",
            actualUsd: null,
          }),
        ]);
        expect(report.totals).toMatchObject({
          actualUsd: FAKE_ACTUAL_MICROS / 1e6,
          unknownCostCalls: 1,
          remainingUsd: 5 - (FAKE_ACTUAL_MICROS + FAKE_ESTIMATE_MICROS) / 1e6,
        });
      } finally {
        if (images) await chmod(images, 0o700);
        await application.close();
      }
    },
    60_000,
  );

  test.skipIf(asRoot)(
    "a settle that fails after an interrupt is a warning naming the Candidate; the call stays unsettled",
    async () => {
      let images = "";
      const warnings: RunWarning[] = [];
      let databasePath = "";
      let dataDirectory = "";
      const app = await setup(
        ["same", "same"],
        {
          // Recording Candidate 1's call is made to fail, so settling it after the interrupt fails.
          beforeAnswer: async (call) => {
            if (call === 1) return new Promise<void>(() => {});
            tamper(
              databasePath,
              `CREATE TRIGGER block_candidate_1 BEFORE UPDATE ON cost_records
               WHEN NEW.candidate = 1 BEGIN SELECT RAISE(ABORT, 'blocked by the test'); END`,
            );
            images = join(dataDirectory, "images");
            await chmod(images, 0o500);
          },
        },
        (warning) => warnings.push(warning),
      );
      ({ databasePath, dataDirectory } = app);
      try {
        const error = await app.application
          .start(request({ candidates: 2 }))
          .catch((failure: unknown) => failure);
        const { runId } = JSON.parse(errorLine(error));
        expect(warnings).toEqual([
          expect.objectContaining({
            warning: "Settling interrupted call 0 failed",
            runId,
            lane: 0,
            iteration: 1,
            candidate: 1,
            cause: expect.stringContaining("blocked by the test"),
          }),
        ]);
        const report = await app.application.report(runId);
        expect(report.unattributedCalls).toContainEqual(
          expect.objectContaining({ candidate: 1, settled: false, result: null, actualUsd: null }),
        );
      } finally {
        if (images) await chmod(images, 0o700);
        await app.application.close();
      }
    },
    60_000,
  );

  test.skipIf(asRoot)(
    "a stored Candidate image that can't be read fails the Run naming the Candidate",
    async () => {
      let unreadable = "";
      const { application, dataDirectory } = await setup(["same", "fail"], {
        // Once Candidate 0's image is stored, and before Candidate 1 answers, make it unreadable.
        beforeAnswer: async (call) => {
          if (call !== 1) return;
          const bytes = await Bun.file(faceFixture("biden-2013.jpg")).bytes();
          const sha256 = Bun.CryptoHasher.hash("sha256", bytes, "hex");
          unreadable = imagePath(dataDirectory, sha256, "image/jpeg");
          // Polled, not watched: a watch on a directory the store hasn't created yet can miss it.
          while (!(await Bun.file(unreadable).exists())) await Bun.sleep(5);
          await chmod(unreadable, 0o000);
        },
      });
      try {
        const error = await application.start(request({ candidates: 2 })).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        const line = JSON.parse(errorLine(error));
        expect(line.error).toContain("Reading Candidate 0's image");
        expect(line.error).toContain(unreadable);
        expect(line.runId).toBeString();
      } finally {
        if (unreadable) await chmod(unreadable, 0o600);
        await application.close();
      }
    },
    60_000,
  );
});

/** Five accepted photos; photo 5 is a group photo whose face 2 is the Subject. */
const fivePhotos = {
  photos: [
    "biden-2022.jpg",
    "biden-2013.jpg",
    "biden-2021.jpg",
    "biden-2021.heic",
    "obama-biden-2015.jpg",
  ].map(faceFixture),
  faceChoices: [{ photo: 5, face: 2 }],
};

describe("Run engine with two Lanes", () => {
  const GEMINI = "gemini-nano-banana-2.1";
  const OPENAI = "gpt-image-2.5-sunburst";

  test("Gemini and OpenAI Lanes run concurrently, each with its own photos, Prompt and reference limit", async () => {
    // Every call waits until both Lanes have a call in flight: Lanes run one after the
    // other would never get there, and the test times out.
    const models = new Set<string>();
    const overlap = Promise.withResolvers<void>();
    const { application, fake } = await setup(
      { [GEMINI]: ["same", "refuse"], [OPENAI]: ["same", "different"] },
      {
        beforeAnswer: async (_, model) => {
          models.add(model);
          if (models.size === 2) overlap.resolve();
          await overlap.promise;
        },
      },
    );
    try {
      const geminiPrompt = "A studio headshot of the person in the reference photos.";
      const { runId, lanes } = await application.start(
        request({
          ...fivePhotos,
          candidates: 2,
          lanes: [{ model: GEMINI, photos: [1, 3], prompt: geminiPrompt }, { model: OPENAI }],
        }),
      );
      expect(lanes.map(({ lane, stopReason }) => ({ lane, stopReason }))).toEqual([
        { lane: 0, stopReason: "iteration-limit" },
        { lane: 1, stopReason: "iteration-limit" },
      ]);
      const sentTo = (model: string) => fake.requests.filter((sent) => sent.model === model);
      expect(sentTo(GEMINI)).toHaveLength(2);
      expect(sentTo(OPENAI)).toHaveLength(2);
      for (const sent of sentTo(GEMINI)) {
        expect(sent.prompt).toBe(geminiPrompt);
        expect(sent.references).toHaveLength(2);
      }
      // The OpenAI Lane takes every accepted photo (up to 16) and the Target Look's Prompt.
      for (const sent of sentTo(OPENAI)) {
        expect(sent.prompt).toContain(DEFAULT_TARGET_LOOK.clothing);
        expect(sent.references).toHaveLength(5);
        expect(sent.size).toBe("1024x1024");
      }

      const report = await application.report(runId);
      const [gemini, openai] = report.lanes;
      const promptsOf = (lane: Report["lanes"][number]) => lane.prompts.map(({ prompt }) => prompt);
      expect(gemini).toMatchObject({ model: GEMINI });
      expect(promptsOf(gemini!)).toEqual([geminiPrompt]);
      expect([...gemini!.characterReferences].sort()).toEqual([1, 3]);
      expect(gemini!.candidates.map(({ outcome }) => outcome)).toEqual(["Scored", "Refused"]);
      expect(openai).toMatchObject({ model: OPENAI });
      expect(promptsOf(openai!)).toEqual([sentTo(OPENAI)[0]!.prompt]);
      expect([...openai!.characterReferences].sort()).toEqual([1, 2, 3, 4, 5]);
      expect(openai!.candidates.map(({ outcome }) => outcome).sort()).toEqual(["Gated", "Scored"]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("concurrent Lanes share one Budget and never overspend it; each Lane says why it stopped", async () => {
    // Each call costs exactly its $0.10 estimate; $0.35 fits three of the four first calls the two
    // Lanes want. Every call is held until three are in flight: no Lane reserves more than two,
    // so both Lanes hold reservations at once, and the Budget must count the other Lane's too.
    const threeInFlight = Promise.withResolvers<void>();
    const { application, fake } = await setup(
      { [GEMINI]: ["same", "same"], [OPENAI]: ["same", "same"] },
      {
        actualMicros: FAKE_ESTIMATE_MICROS,
        beforeAnswer: (call) => {
          if (call >= 2) threeInFlight.resolve();
          return threeInFlight.promise;
        },
      },
    );
    try {
      const { runId, lanes } = await application.start(
        request({ budgetUsd: 0.35, candidates: 2, lanes: [{ model: GEMINI }, { model: OPENAI }] }),
      );
      expect(fake.requests).toHaveLength(3);
      expect(new Set(fake.requests.map(({ model }) => model))).toEqual(new Set([GEMINI, OPENAI]));
      const report = await application.report(runId);
      // What every call commits: its actual cost once known, else its reserved estimate.
      const committed = [
        ...report.lanes.flatMap(({ candidates }) => candidates.flatMap(({ calls }) => calls)),
        ...report.unattributedCalls,
      ].reduce((sum, call) => sum + (call.actualUsd ?? call.estimatedUsd), 0);
      expect(committed).toBeLessThanOrEqual(0.35);
      // Three calls fit; the fourth Candidate is stored Failed, without a call.
      const called = report.lanes.map(({ candidates }) =>
        candidates.filter(({ calls }) => calls.length > 0),
      );
      expect(called.flat()).toHaveLength(3);
      // A Lane that got fewer than its two Candidates' calls stopped for the Budget.
      for (const lane of report.lanes) {
        const stopReason = called[lane.lane]!.length < 2 ? "budget-exhausted" : "iteration-limit";
        expect(lane.stopReason).toBe(stopReason);
        expect(lanes[lane.lane]!.stopReason).toBe(stopReason);
      }
    } finally {
      await application.close();
    }
  }, 60_000);

  test("two Lanes' retries race for the last Budget slot: exactly the calls that fit are made", async () => {
    // $0.35 fits three $0.10 calls. Both first calls are held until both are in flight, then fail
    // transiently at an unknown cost (each counts its $0.10), so the two Lanes' retries race for
    // the one remaining slot.
    const bothInFlight = Promise.withResolvers<void>();
    const { application, fake } = await setup(
      { [GEMINI]: ["transient", "same"], [OPENAI]: ["transient", "same"] },
      {
        transientCost: null,
        beforeAnswer: (call) => {
          if (call >= 1) bothInFlight.resolve();
          return bothInFlight.promise;
        },
      },
    );
    try {
      const { runId, lanes } = await application.start(
        request({ budgetUsd: 0.35, candidates: 1, lanes: [{ model: GEMINI }, { model: OPENAI }] }),
      );
      expect(fake.requests).toHaveLength(3);
      const report = await application.report(runId);
      const outcomes = report.lanes.map(({ candidates }) => candidates[0]!);
      expect(outcomes.filter(({ outcome }) => outcome === "Scored")).toHaveLength(1);
      expect(outcomes.filter(({ outcome }) => outcome === "Failed")).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining("retry not made: Budget exhausted"),
        }),
      ]);
      // The Lane whose retry didn't fit stopped for the Budget; the other ran its Iteration.
      expect(lanes.map(({ stopReason }) => stopReason).sort()).toEqual([
        "budget-exhausted",
        "iteration-limit",
      ]);
      expect(report.totals.estimatedUsd).toBeLessThanOrEqual(0.35);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("the estimate prices each Lane's first Iteration with its own Prompt, later ones with the longest", async () => {
    const events: unknown[] = [];
    // One micro-dollar per Prompt character, so the estimate shows which Prompt was used.
    const { application } = await setup(
      Array.from({ length: 6 }, () => "same" as const),
      { estimateMicros: ({ prompt }) => prompt.length },
    );
    try {
      const own = "A studio headshot.";
      await application.start(
        request({
          candidates: 1,
          lanes: [{ model: GEMINI, prompt: own }, { model: OPENAI }],
          stopRules: { ...DEFAULT_STOP_RULES, maxIterations: 3 },
        }),
        (event) => events.push(event),
      );
      const defaultLength = initialPrompt(DEFAULT_TARGET_LOOK).length;
      // Iterations 2 and 3 send whatever Prompt the Optimizer writes: at most the longest.
      const later = 2 * MAX_PROMPT_LENGTH;
      expect(events).toEqual([
        expect.objectContaining({
          lanes: [
            expect.objectContaining({
              lane: 0,
              perCallUsd: own.length / 1e6,
              estimatedUsd: (own.length + later) / 1e6,
            }),
            expect.objectContaining({
              lane: 1,
              perCallUsd: defaultLength / 1e6,
              estimatedUsd: (defaultLength + later) / 1e6,
            }),
          ],
        }),
      ]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("read shows each Lane's stored Prompt history, and none for a Lane that lost its Iteration (died mid-prepare)", async () => {
    const { application, databasePath, dataDirectory } = await setup([]);
    try {
      const own = "A studio headshot.";
      const look = { ...DEFAULT_TARGET_LOOK, clothing: "a green knitted jumper" };
      // A Budget below one call: the Run makes no call and has no Candidates.
      const { runId } = await application.start(
        request({
          budgetUsd: 0.05,
          targetLook: look,
          lanes: [{ model: GEMINI, prompt: own }, { model: OPENAI }],
        }),
      );
      const prompts = (report: Report) =>
        report.lanes.map((lane) => lane.prompts.map(({ prompt, source }) => [prompt, source]));
      expect(prompts(await application.report(runId))).toEqual([
        [[own, "initial"]],
        [[initialPrompt(look), "initial"]],
      ]);
      // The report reads what was stored (and sent), not a Prompt rebuilt from today's template.
      await tamper(databasePath, "UPDATE iterations SET prompt = 'as sent' WHERE lane = 1");
      await tamper(databasePath, "DELETE FROM iterations WHERE lane = 0");
      expect(prompts(await application.report(runId))).toEqual([[], [["as sent", "initial"]]]);
      // Any other fault reading the Prompts still fails `read`, rather than showing none. The
      // table is renamed with the application closed, and `read` opens its own read-only
      // connection (which creates no tables), so every platform sees the schema change.
      await application.close();
      await tamper(databasePath, "ALTER TABLE iterations RENAME TO iterations_moved");
      await expect(readRunReport(databasePath, dataDirectory, runId)).rejects.toThrow(
        "Loading the Iterations of Run",
      );
    } finally {
      await application.close().catch(() => {});
    }
  }, 60_000);

  test("the Judge scores both Lanes' Scored Candidates, and one Budget counts both Lanes' generate and judge calls", async () => {
    const { application, judge } = await setup({
      [GEMINI]: ["same", "different"],
      [OPENAI]: ["same", "same"],
    });
    try {
      const { runId } = await application.start(
        request({ candidates: 2, lanes: [{ model: GEMINI }, { model: OPENAI }] }),
      );
      const report = await application.report(runId);
      const [gemini, openai] = report.lanes;
      expect(gemini!.candidates.map(({ outcome }) => outcome)).toEqual(["Scored", "Gated"]);
      expect(openai!.candidates.map(({ outcome }) => outcome)).toEqual(["Scored", "Scored"]);
      // Every Scored Candidate of either Lane is judged once; the Gated one never.
      expect(judge.requests).toHaveLength(3);
      for (const { outcome, judgement, judgeCost } of [
        ...gemini!.candidates,
        ...openai!.candidates,
      ]) {
        expect(judgement?.status ?? null).toBe(outcome === "Scored" ? "judged" : null);
        expect(judgeCost.calls).toHaveLength(outcome === "Scored" ? 1 : 0);
      }
      const spentMicros = 4 * FAKE_ACTUAL_MICROS + 3 * FAKE_JUDGE_ACTUAL_MICROS;
      expect(report.totals.actualUsd).toBeCloseTo(spentMicros / 1e6, 10);
      expect(report.totals.remainingUsd).toBeCloseTo(5 - spentMicros / 1e6, 10);
      expect(report.warnings).toEqual([]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("one Lane's generation leaves no room for the other Lane's Judge calls", async () => {
    // $0.22 fits both $0.10 image calls (held until both are in flight, so both are reserved
    // before any Judge call), settled at their estimate. The $0.02 left fits no $0.03 Judge call,
    // though a Lane alone would have had $0.12 for it.
    const bothInFlight = Promise.withResolvers<void>();
    const { application, fake, judge } = await setup(
      { [GEMINI]: ["same"], [OPENAI]: ["same"] },
      {
        actualMicros: FAKE_ESTIMATE_MICROS,
        beforeAnswer: (call) => {
          if (call >= 1) bothInFlight.resolve();
          return bothInFlight.promise;
        },
      },
      undefined,
      [],
      { estimateMicros: 30_000 },
    );
    try {
      const { runId, lanes } = await application.start(
        request({ budgetUsd: 0.22, candidates: 1, lanes: [{ model: GEMINI }, { model: OPENAI }] }),
      );
      expect(fake.requests).toHaveLength(2);
      expect(judge.requests).toHaveLength(0);
      expect(lanes.map(({ stopReason }) => stopReason)).toEqual([
        "budget-exhausted",
        "budget-exhausted",
      ]);
      const report = await application.report(runId);
      for (const lane of report.lanes) {
        expect(lane.candidates).toEqual([
          expect.objectContaining({
            outcome: "Scored",
            judgement: expect.objectContaining({
              status: "judge-failed",
              cause: "budget-exhausted",
            }),
          }),
        ]);
      }
      expect(committedUsd(report)).toBeLessThanOrEqual(0.22);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("an openai/ Judge with an OpenAI Lane warns judge-same-vendor, naming that Lane only", async () => {
    const { application } = await setup({ [GEMINI]: ["same"], [OPENAI]: ["same"] });
    try {
      const { runId } = await application.start(
        request({
          candidates: 1,
          lanes: [{ model: GEMINI }, { model: OPENAI }],
          judge: { ...DEFAULT_JUDGE, model: "openai/gpt-5.5" },
        }),
      );
      const report = await application.report(runId);
      expect(report.warnings).toEqual([
        { code: "judge-same-vendor", message: expect.any(String), lanes: [1] },
      ]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Lane whose photos are all rejected, or a pin outside a Lane's photos, fails the Run before any call", async () => {
    const { application, fake } = await setup(["same"]);
    try {
      const photos = [...subjectPhotos, faceFixture("earth-apollo17.jpg")];
      await expect(
        application.start(
          request({ photos, lanes: [{ model: GEMINI }, { model: OPENAI, photos: [3] }] }),
        ),
      ).rejects.toThrow(`None of the photos of Lane 1 (${OPENAI}) (3) was accepted`);
      await expect(
        application.start(
          request({ pins: [2], lanes: [{ model: GEMINI }, { model: OPENAI, photos: [1] }] }),
        ),
      ).rejects.toThrow(`Pinned photo 2 is not among the photos of Lane 1 (${OPENAI})`);
      await expect(
        application.start(request({ lanes: [{ model: OPENAI, photos: [3] }] })),
      ).rejects.toThrow("A Lane lists photo 3, but the Run has 2 Reference Photos");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await application.close();
    }
  }, 60_000);
});

describe("Run engine with a fake Judge", () => {
  /** Images as the Judge sees them: normalised, at most 1024 px. */
  const judgeDownscaled = async (images: readonly EncodedImage[]) => {
    const directory = await temporaryDirectory();
    return Promise.all(
      images.map(async (image, index) => {
        const path = join(directory, `${index}.jpg`);
        await Bun.write(path, image.bytes);
        return readImageAtMost(path, image.mimeType, JUDGE_IMAGE_MAX_SIDE, { normalise: true });
      }),
    );
  };

  test("every image the Judge sees is at most 1024 px, while Image Models get up to 2048 px", async () => {
    const directory = await temporaryDirectory();
    const largeCandidate = await enlargedFixture("biden-2013.jpg", 2000, 2500, directory);
    const largePhoto = await enlargedFixture("biden-2022.jpg", 1300, 1600, directory);
    const { application, fake, judge } = await setup(["same"], { sameImage: largeCandidate });
    try {
      await application.start(
        request({ photos: [largePhoto, faceFixture("biden-2021.jpg")], candidates: 1 }),
      );
      expect(judge.requests).toHaveLength(1);
      const [sent] = judge.requests;
      for (const image of [...sent!.references, sent!.candidate]) {
        const { width, height } = await imageSize(image.bytes);
        expect(Math.max(width, height)).toBeLessThanOrEqual(JUDGE_IMAGE_MAX_SIDE);
      }
      // The 1600 px photo reaches the Image Model as stored, and the Judge downscaled.
      const sizes = await Promise.all(
        fake.requests[0]!.references.map(async ({ bytes }) => imageSize(bytes)),
      );
      expect(sizes.map(({ height }) => height)).toContain(1600);
      expect(sent!.references).toEqual(await judgeDownscaled(fake.requests[0]!.references));
    } finally {
      await application.close();
    }
  }, 60_000);

  test("judges only Scored Candidates, with 3 Reference Photos before each, and stores every score", async () => {
    const { application, fake, judge } = await setup(
      ["same", "different", "no-face", "refuse", "fail", "same"],
      {},
      undefined,
      [{ levels: { ...levels(4), resemblance: 1 }, issues: ["Eyes look glassy"], promptFixes: [] }],
    );
    try {
      const { runId } = await application.start(request({ ...fivePhotos, candidates: 6 }));
      const report = await application.report(runId);
      const [lane] = report.lanes;
      expect(lane!.candidates.map(({ outcome }) => outcome)).toEqual([
        "Scored",
        "Gated",
        "Gated",
        "Refused",
        "Failed",
        "Scored",
      ]);
      // Gated, Refused and Failed Candidates never reach the Judge.
      expect(judge.requests).toHaveLength(2);
      for (const { judgement, judgeCost } of lane!.candidates.slice(1, 5)) {
        expect(judgement).toBeNull();
        expect(judgeCost.calls).toEqual([]);
      }

      // The Judge saw the Run's 3 representative photos, in the same order every time: the
      // first three of the ranking that chose the Lane's 4 character references.
      expect(report.judge).toMatchObject({
        model: DEFAULT_JUDGE.model,
        effort: "low",
        weights: DEFAULT_JUDGE.weights,
        rubricVersion: "rubric-v1",
        referencePhotos: lane!.characterReferences.slice(0, 3),
      });
      const sentToImageModel = await judgeDownscaled(fake.requests[0]!.references.slice(0, 3));
      for (const sent of judge.requests) {
        expect(sent.references).toEqual(sentToImageModel);
        expect(sent.targetLook).toEqual(DEFAULT_TARGET_LOOK);
      }
      // Each call carried its own Candidate's stored image, as the Judge sees images.
      for (const [index, sent] of judge.requests.entries()) {
        const candidate = lane!.candidates.filter(({ outcome }) => outcome === "Scored")[index]!;
        const stored = await readImageAtMost(
          candidate.image!.path,
          "image/jpeg",
          JUDGE_IMAGE_MAX_SIDE,
          {
            normalise: true,
          },
        );
        expect(sent.candidate).toEqual(stored);
      }

      const judged = lane!.candidates.filter(({ outcome }) => outcome === "Scored");
      for (const candidate of judged) {
        if (candidate.outcome !== "Scored" || candidate.judgement?.status !== "judged") {
          throw new Error("expected a judged Candidate");
        }
        const { judgement, likeness } = candidate;
        // Likeness and Resemblance stay separate; the total weighs both.
        expect(judgement.scores.likeness).toBe(likeness);
        expect(judgement.rubricVersion).toBe("rubric-v1");
        expect(judgement.disputed).toBe(Math.abs(likeness - judgement.resemblance) > 4);
        expect(judgement.weightedTotal).toBeCloseTo(
          0.3 * likeness + 0.15 * judgement.resemblance + 0.55 * 7.5,
          10,
        );
        expect(candidate.judgeCost).toMatchObject({
          estimatedUsd: FAKE_JUDGE_ESTIMATE_MICROS / 1e6,
          actualUsd: FAKE_JUDGE_ACTUAL_MICROS / 1e6,
        });
        expect(candidate.judgeCost.calls).toEqual([
          expect.objectContaining({ purpose: "judge", attempt: 0, result: "judged" }),
        ]);
        expect(candidate.calls.map(({ purpose }) => purpose)).toEqual(["generate"]);
      }
      // Resemblance level 1 is 0 points; this Candidate's Likeness is far above 4: Disputed.
      if (judged[0]?.outcome !== "Scored") throw new Error("expected a Scored Candidate");
      expect(judged[0].likeness).toBeGreaterThan(4);
      expect(judged[0]!.judgement).toMatchObject({
        disputed: true,
        resemblance: 0,
        issues: ["Eyes look glassy"],
        promptFixes: [],
      });
      expect(judged[1]!.judgement).toMatchObject({
        disputed: false,
        resemblance: 7.5,
        issues: ["The collar is asymmetric"],
        promptFixes: ["Make the shirt collar symmetric"],
      });
      expect(report.warnings).toEqual([]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("the Run's own weights are stored with it and weigh every score", async () => {
    const weights = { ...DEFAULT_JUDGE.weights, likeness: 0, resemblance: 0.45 };
    const { application } = await setup(["same"]);
    try {
      const { runId } = await application.start(
        request({ candidates: 1, judge: { ...DEFAULT_JUDGE, weights } }),
      );
      const report = await application.report(runId);
      expect(report.judge.weights).toEqual(weights);
      const [candidate] = report.lanes[0]!.candidates;
      if (candidate?.judgement?.status !== "judged") throw new Error("expected a judged Candidate");
      // Every judged criterion is at 7.5 points; Likeness weighs nothing.
      expect(candidate.judgement.weightedTotal).toBeCloseTo(7.5, 10);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Judge call that doesn't fit is not made: the Lane stops and its Candidate is judge-failed", async () => {
    // $0.20 fits both $0.10 image reservations; they settle at $0.08 each, leaving $0.04:
    // one $0.03 Judge call fits, the second doesn't.
    const { application, judge } = await setup(["same", "same"], {}, undefined, [], {
      estimateMicros: 30_000,
    });
    try {
      const { runId, lanes } = await application.start(request({ candidates: 2, budgetUsd: 0.2 }));
      expect(judge.requests).toHaveLength(1);
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      const report = await application.report(runId);
      const [first, second] = report.lanes[0]!.candidates;
      expect(first!.judgement?.status).toBe("judged");
      expect(second).toMatchObject({
        outcome: "Scored",
        likeness: expect.any(Number),
        judgement: {
          status: "judge-failed",
          rubricVersion: "rubric-v1",
          cause: "budget-exhausted",
          reason: expect.stringContaining("didn't fit the Budget"),
        },
        judgeCost: { calls: [] },
      });
      expect(committedUsd(report)).toBeLessThanOrEqual(0.2);
    } finally {
      await application.close();
    }
  }, 60_000);

  test.each([
    [
      "transient errors are retried, then the Candidate is judge-failed",
      ["transient", "transient", "transient"],
      3,
      "gave-up",
      "gave up after 3 attempts",
    ],
    ["a failure is not retried", ["fail"], 1, "failed", "fake Judge HTTP 400"],
    ["a refusal is not retried", ["refuse"], 1, "refused", "The Judge refused: fake: declined"],
  ] as const)(
    "%s; it keeps its Likeness and gets no Rubric score",
    async (_, script, calls, cause, reason) => {
      const { application, judge } = await setup(["same"], {}, undefined, script);
      try {
        const { runId, lanes } = await application.start(request({ candidates: 1 }));
        expect(lanes[0]!.stopReason).toBe("iteration-limit");
        expect(judge.requests).toHaveLength(calls);
        const [candidate] = (await application.report(runId)).lanes[0]!.candidates;
        expect(candidate).toMatchObject({
          outcome: "Scored",
          likeness: expect.any(Number),
          judgement: {
            status: "judge-failed",
            cause,
            reason: expect.stringContaining(reason),
          },
        });
        expect(candidate!.judgeCost.calls.map(({ attempt }) => attempt)).toEqual(
          Array.from({ length: calls }, (_, attempt) => attempt),
        );
      } finally {
        await application.close();
      }
    },
    60_000,
  );

  test("a re-executed judge phase finds the stored judgements and calls the Judge no more", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same", "same"]);
    try {
      const { runId } = await application.start(request({ candidates: 2 }));
      const before = await application.report(runId);
      await application.close();

      const again = fakeJudges();
      const runtime = ManagedRuntime.make(
        Layer.mergeAll(
          again.layer,
          LibsqlRunStore(databasePath),
          Layer.succeed(RunConfig)(defaultRunConfig(dataDirectory)),
        ),
      );
      try {
        const state = lane0Iteration1(runId);
        // Nothing was left to judge, and nothing ran out: the Lane's state passes on unchanged.
        expect(await runtime.runPromise(judgeIteration(state))).toEqual(state);
        expect(again.requests).toHaveLength(0);
        const after = await runtime.runPromise(runReport(runId));
        expect(after.lanes).toEqual(before.lanes);
        expect(after.totals).toEqual(before.totals);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await application.close().catch(() => {});
    }
  }, 60_000);

  test("a Judge retry that doesn't fit is not made: the Lane stops and the Candidate is judge-failed", async () => {
    // $0.12: the $0.10 image reservation fits and settles at $0.08, leaving $0.04. The first
    // $0.03 Judge call fits; it fails at unknown cost, so it keeps its $0.03 and the retry
    // doesn't fit the $0.01 left.
    const { application, judge } = await setup(
      ["same"],
      {},
      undefined,
      ["transient-unknown-cost"],
      {
        estimateMicros: 30_000,
      },
    );
    try {
      const { runId, lanes } = await application.start(request({ candidates: 1, budgetUsd: 0.12 }));
      expect(judge.requests).toHaveLength(1);
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      const report = await application.report(runId);
      const [candidate] = report.lanes[0]!.candidates;
      expect(candidate).toMatchObject({
        outcome: "Scored",
        judgement: {
          status: "judge-failed",
          cause: "budget-exhausted",
          reason: expect.stringContaining("retry not made: Budget exhausted"),
        },
        judgeCost: { unknownCostCalls: 1 },
      });
      expect(committedUsd(report)).toBeLessThanOrEqual(0.12);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a judged call without a usage report counts at its estimate", async () => {
    const { application } = await setup(["same"], {}, undefined, ["unknown-cost"]);
    try {
      const { runId } = await application.start(request({ candidates: 1 }));
      const report = await application.report(runId);
      const [candidate] = report.lanes[0]!.candidates;
      expect(candidate!.judgement?.status).toBe("judged");
      expect(candidate!.judgeCost).toMatchObject({ actualUsd: 0, unknownCostCalls: 1 });
      expect(report.totals.remainingUsd).toBeCloseTo(
        5 - (FAKE_ACTUAL_MICROS + FAKE_JUDGE_ESTIMATE_MICROS) / 1e6,
        10,
      );
    } finally {
      await application.close();
    }
  }, 60_000);

  test("Judge calls are priced at the Judge's price recorded at Run start, not a later lookup", async () => {
    // Only the lookup at Run start gets the real price; any later one is 10× dearer.
    const { application, judge } = await setup(["same"], {}, undefined, [], {
      lookupPricing: (lookup) =>
        lookup === 0
          ? FAKE_JUDGE_PRICING
          : { _tag: "Llm", inputPerToken: 5e-6, outputPerToken: 1.25e-5 },
    });
    try {
      const { runId } = await application.start(request({ candidates: 1 }));
      const [candidate] = (await application.report(runId)).lanes[0]!.candidates;
      expect(candidate!.judgeCost.actualUsd).toBe(FAKE_JUDGE_ACTUAL_MICROS / 1e6);
      expect(judge.gets.map(({ price }) => price?.pricing)).toEqual([
        undefined,
        FAKE_JUDGE_PRICING,
      ]);
    } finally {
      await application.close();
    }
  }, 60_000);

  /** A Run tool on an existing database: an Iteration's judge phase alone, with a fresh fake Judge. */
  const judgeStepOn = (databasePath: string, dataDirectory: string) => {
    const again = fakeJudges();
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        again.layer,
        LibsqlRunStore(databasePath),
        Layer.succeed(RunConfig)(defaultRunConfig(dataDirectory)),
      ),
    );
    return { again, runtime };
  };

  test("a re-executed judge phase after a call whose judgement was lost judges only that Candidate, numbering on", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same", "same"]);
    const { runId } = await application.start(request({ candidates: 2 }));
    await application.close();
    // Candidate 1's Judge call was sent but the process died: no result, no judgement.
    tamper(databasePath, "DELETE FROM judgements WHERE candidate = 1");
    tamper(
      databasePath,
      `UPDATE cost_records SET settled = 0, actual_micros = NULL, usage = NULL, result = NULL
       WHERE candidate = 1 AND purpose = 'judge'`,
    );
    const { again, runtime } = judgeStepOn(databasePath, dataDirectory);
    try {
      await runtime.runPromise(judgeIteration(lane0Iteration1(runId)));
      expect(again.requests).toHaveLength(1);
      const report = await runtime.runPromise(runReport(runId));
      const [first, second] = report.lanes[0]!.candidates;
      expect(first!.judgeCost.calls.map(({ attempt }) => attempt)).toEqual([0]);
      expect(second!.judgement?.status).toBe("judged");
      expect(second!.judgeCost.calls.map(({ attempt, settled }) => [attempt, settled])).toEqual([
        [0, false],
        [1, true],
      ]);
      // The lost call still counts at its estimate.
      const spent =
        2 * FAKE_ACTUAL_MICROS + 2 * FAKE_JUDGE_ACTUAL_MICROS + FAKE_JUDGE_ESTIMATE_MICROS;
      expect(report.totals.remainingUsd).toBeCloseTo(5 - spent / 1e6, 10);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  test("a judge phase re-executed with a different Rubric version fails instead of mixing versions", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same"]);
    const { runId } = await application.start(request({ candidates: 1 }));
    await application.close();
    tamper(databasePath, "UPDATE judges SET rubric_version = 'rubric-v0'");
    const { again, runtime } = judgeStepOn(databasePath, dataDirectory);
    try {
      await expect(runtime.runPromise(judgeIteration(lane0Iteration1(runId)))).rejects.toThrow(
        "is judged with rubric-v0, but this build has only rubric-v1",
      );
      expect(again.requests).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  test("an unpriced Judge fails the Run before any call", async () => {
    const { application, fake, judge } = await setup(["same"], {}, undefined, [], {
      unpriced: true,
    });
    try {
      await expect(application.start(request())).rejects.toThrow(
        "No price for model claude-sonnet-5-5",
      );
      expect(fake.requests).toHaveLength(0);
      expect(judge.requests).toHaveLength(0);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Judge from a Lane's Image Model vendor is a coded warning in the report", async () => {
    const { application } = await setup(["same"]);
    try {
      const { runId } = await application.start(
        request({
          candidates: 1,
          judge: { ...DEFAULT_JUDGE, model: "google/gemini-3.1-pro-preview" },
        }),
      );
      const report = await application.report(runId);
      expect(report.warnings).toEqual([
        { code: "judge-same-vendor", message: expect.any(String), lanes: [0] },
      ]);
    } finally {
      await application.close();
    }
  }, 60_000);
});

describe("Run engine loop: Iterations, the Optimizer and stopping rules", () => {
  /** One Candidate per Iteration under issue #1's stopping rules, unless overridden. */
  const loop = (overrides: Partial<RunRequest> = {}) =>
    request({ candidates: 1, stopRules: DEFAULT_STOP_RULES, ...overrides });
  const rules = (overrides: Partial<RunRequest["stopRules"]>) => ({
    stopRules: { ...DEFAULT_STOP_RULES, ...overrides },
  });
  /** Every criterion at level 5: a weighted total of 10 for a Likeness of 10. */
  const topVerdict = { ...FAKE_VERDICT, levels: levels(5) };

  test("a Lane iterates until its best reaches the target; the next Iteration sends the Optimizer's Prompt", async () => {
    const better = "A sharper studio headshot, collar symmetric.";
    const { application, fake, optimizer } = await setup(
      ["same", "same"],
      {},
      undefined,
      [FAKE_VERDICT, topVerdict],
      {},
      [better],
    );
    try {
      const events: unknown[] = [];
      const { runId, lanes } = await application.start(loop(), (event) => events.push(event));
      const report = await application.report(runId);
      const [lane] = report.lanes;
      const [first, second] = lane!.candidates;
      const total = (candidate: typeof first) =>
        candidate?.judgement?.status === "judged" ? candidate.judgement.weightedTotal : null;
      expect(total(first)).toBeLessThan(8.5);
      expect(total(second)).toBeGreaterThanOrEqual(8.5);
      expect(lanes).toEqual([
        {
          runId,
          lane: 0,
          stopReason: "target-score",
          iterations: 2,
          best: { iteration: 2, candidate: 0, score: total(second)! },
        },
      ]);
      expect(lane).toMatchObject({
        stopReason: "target-score",
        iterations: 2,
        best: { iteration: 2, candidate: 0, score: total(second) },
      });
      // Iteration 1 sent the Target Look's Prompt, Iteration 2 the Optimizer's.
      expect(fake.requests.map(({ prompt }) => prompt)).toEqual([
        initialPrompt(DEFAULT_TARGET_LOOK),
        better,
      ]);
      // Iteration 1's Optimizer call wrote Iteration 2's Prompt; it is booked under Iteration 1.
      expect(lane!.prompts).toEqual([
        expect.objectContaining({
          iteration: 1,
          source: "initial",
          optimizerCost: expect.objectContaining({
            estimatedUsd: FAKE_OPTIMIZER_ESTIMATE_MICROS / 1e6,
            actualUsd: FAKE_OPTIMIZER_ACTUAL_MICROS / 1e6,
            calls: [expect.objectContaining({ purpose: "optimize", result: "optimized" })],
          }),
        }),
        expect.objectContaining({
          iteration: 2,
          prompt: better,
          source: "optimizer",
          optimizerCost: expect.objectContaining({ calls: [] }),
        }),
      ]);
      // The Optimizer saw Iteration 1's Prompt, scores and the Judge's notes.
      const [seen] = optimizer.requests;
      expect(seen!.history.map(({ prompt }) => prompt)).toEqual([
        initialPrompt(DEFAULT_TARGET_LOOK),
      ]);
      expect(seen!.history[0]!.candidates[0]!.judgement).toMatchObject({
        _tag: "Judged",
        issues: FAKE_VERDICT.issues,
        promptFixes: FAKE_VERDICT.promptFixes,
      });
      // The estimate quotes all 8 Iterations and the 7 Optimizer calls between them, each of
      // those at no less than the fake's estimate (the domain tests bound the quote).
      expect(events).toHaveLength(1);
      const [estimate] = events as EstimateEvent[];
      expect(estimate).toMatchObject({ maxIterations: 8, optimizer: { calls: 7 } });
      const optimizerQuote = estimate!.optimizer.perCallUsd;
      expect(optimizerQuote).toBeGreaterThanOrEqual(FAKE_OPTIMIZER_ESTIMATE_MICROS / 1e6);
      expect(estimate!.optimizer.estimatedUsd).toBeCloseTo(7 * optimizerQuote, 10);
      expect(estimate!.estimatedUsd).toBeCloseTo(8 * 0.11 + 7 * optimizerQuote, 10);
      const spent =
        2 * FAKE_ACTUAL_MICROS + 2 * FAKE_JUDGE_ACTUAL_MICROS + FAKE_OPTIMIZER_ACTUAL_MICROS;
      expect(report.totals.actualUsd).toBeCloseTo(spent / 1e6, 10);
      expect(committedUsd(report)).toBeCloseTo(spent / 1e6, 10);
    } finally {
      await application.close();
    }
  }, 60_000);

  /** Each Iteration's billed Optimizer calls, as the report shows them. */
  const optimizerCallsPerIteration = (report: Report) =>
    report.lanes[0]!.prompts.map(({ optimizerCost }) => optimizerCost.calls.length);

  test("patience: 3 Iterations without the best rising by 0.2 stop the Lane", async () => {
    // The fake Judge scores every Candidate the same.
    const { application } = await setup(["same", "same", "same", "same"]);
    try {
      const { runId, lanes } = await application.start(loop());
      expect(lanes[0]).toMatchObject({
        stopReason: "patience",
        iterations: 4,
        best: { iteration: 1, candidate: 0 },
      });
      expect(optimizerCallsPerIteration(await application.report(runId))).toEqual([1, 1, 1, 0]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("the Iteration limit stops the Lane after its last Iteration, with no Optimizer call after it", async () => {
    const { application } = await setup(["same", "same"]);
    try {
      const { runId, lanes } = await application.start(loop(rules({ maxIterations: 2 })));
      expect(lanes[0]).toMatchObject({ stopReason: "iteration-limit", iterations: 2 });
      expect(optimizerCallsPerIteration(await application.report(runId))).toEqual([1, 0]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("two Iterations in a row whose Candidates were all Refused or Failed stop the Lane; the Optimizer saw why", async () => {
    const { application, optimizer } = await setup(["refuse", "fail", "refuse", "fail"]);
    try {
      const { lanes } = await application.start(loop({ candidates: 2 }));
      expect(lanes[0]).toMatchObject({
        stopReason: "repeated-failures",
        iterations: 2,
        best: null,
      });
      expect(optimizer.requests).toHaveLength(1);
      expect(optimizer.requests[0]!.history[0]!.candidates.map(({ outcome }) => outcome)).toEqual([
        { _tag: "Refused", reason: "safety: blocked by the fake" },
        { _tag: "Failed", reason: "fake HTTP 400: bad request" },
      ]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("an Optimizer call that doesn't fit the Budget isn't made, and the Lane stops", async () => {
    // $0.10: the image's $0.10 reservation fits and settles at $0.08, the Judge's $0.01 at
    // $0.005, leaving $0.015, below the Optimizer's $0.02 estimate.
    const { application } = await setup(["same"]);
    try {
      const { runId, lanes } = await application.start(loop({ budgetUsd: 0.1 }));
      expect(lanes[0]).toMatchObject({ stopReason: "budget-exhausted", iterations: 1 });
      const report = await application.report(runId);
      expect(optimizerCallsPerIteration(report)).toEqual([0]);
      expect(report.unattributedCalls).toEqual([]);
      expect(report.totals.remainingUsd).toBeCloseTo(0.015, 10);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("the Budget running out mid-loop stops the Lane at the Iteration whose call didn't fit", async () => {
    // $0.20: Iteration 1 spends $0.085, the Optimizer $0.003, Iteration 2 $0.085 and the next
    // Optimizer call $0.003; Iteration 3's $0.10 image no longer fits the $0.024 left.
    const { application, fake } = await setup(["same", "same"]);
    try {
      const { runId, lanes } = await application.start(loop({ budgetUsd: 0.2 }));
      expect(lanes[0]).toMatchObject({ stopReason: "budget-exhausted", iterations: 3 });
      expect(fake.requests).toHaveLength(2);
      const report = await application.report(runId);
      expect(optimizerCallsPerIteration(report)).toEqual([1, 1, 0]);
      // Iteration 3's Candidate made no call: stored Failed, saying the Budget ran out.
      expect(
        report.lanes[0]!.candidates.map(({ iteration, outcome }) => [iteration, outcome]),
      ).toEqual([
        [1, "Scored"],
        [2, "Scored"],
        [3, "Failed"],
      ]);
      expect(committedUsd(report)).toBeLessThanOrEqual(0.2);
      expect(report.totals.remainingUsd).toBeCloseTo(0.024, 10);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("cancelling a Run aborts its in-flight calls, and its Lane reports cancelled", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    // The second Iteration's image call answers only when aborted, or when the test ends.
    const { application, fake } = await setup(["same", "same"], {
      beforeAnswer: async (call) => {
        if (call === 1) await held;
      },
    });
    try {
      const run = await application.mastra.getWorkflow("run").createRun();
      const started = run.start({ inputData: loop() });
      await until(async () => fake.requests.length === 2, { timeoutMs: 20_000 });
      await run.cancel();
      // Mastra's result type leaves out the cancelled status it returns.
      const result: { readonly status: string } = await started;
      expect(result.status).toBe("canceled");
      // Mastra ends the Run without waiting for the aborted step to record what it cleaned up.
      const cancelled = async () =>
        (await application.report(run.runId)).lanes[0]!.stopReason === "cancelled";
      await until(cancelled, { timeoutMs: 10_000 });
      const report = await application.report(run.runId);
      // The aborted call has no Candidate; it was settled as sent, at unknown cost.
      expect(report.lanes[0]!.candidates.map(({ iteration }) => iteration)).toEqual([1]);
      expect(report.unattributedCalls).toEqual([
        expect.objectContaining({
          iteration: 2,
          candidate: 0,
          purpose: "generate",
          settled: true,
          result: "transient",
          actualUsd: null,
        }),
      ]);
    } finally {
      release();
      await application.close();
    }
  }, 60_000);

  test("each Lane keeps its own Prompt history: an Optimizer call never sees another Lane's Prompts", async () => {
    const GEMINI = "gemini-nano-banana-2.1";
    const OPENAI = "gpt-image-2.5-sunburst";
    const { application, fake, optimizer } = await setup(["same", "same", "same", "same"]);
    try {
      const { runId } = await application.start(
        loop({
          lanes: [
            { model: GEMINI, prompt: "Lane A's Prompt" },
            { model: OPENAI, prompt: "Lane B's Prompt" },
          ],
          ...rules({ maxIterations: 2 }),
        }),
      );
      // The fake Optimizer answers its n-th call with "Prompt n".
      const written = new Map(
        optimizer.requests.map((request, call) => [
          request.history.map(({ prompt }) => prompt).join(" | "),
          `Prompt ${call + 1}`,
        ]),
      );
      expect([...written.keys()].sort()).toEqual(["Lane A's Prompt", "Lane B's Prompt"]);
      const report = await application.report(runId);
      const history = (lane: number) => report.lanes[lane]!.prompts.map(({ prompt }) => prompt);
      expect(history(0)).toEqual(["Lane A's Prompt", written.get("Lane A's Prompt")!]);
      expect(history(1)).toEqual(["Lane B's Prompt", written.get("Lane B's Prompt")!]);
      const sentTo = (model: string) =>
        fake.requests.filter((sent) => sent.model === model).map(({ prompt }) => prompt);
      expect(sentTo(GEMINI)).toEqual(history(0));
      expect(sentTo(OPENAI)).toEqual(history(1));
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Run's target score replaces the default: 8.6 stops a Lane at 8.5, not at 9", async () => {
    // Resemblance at level 5, the rest at 4: a weighted total between 8.5 and 9.
    const verdict = { ...FAKE_VERDICT, levels: { ...levels(4), resemblance: 5 } };
    const { application } = await setup(["same", "same"], {}, undefined, [verdict, verdict]);
    try {
      const { runId, lanes } = await application.start(
        loop(rules({ targetScore: 9, maxIterations: 2 })),
      );
      const report = await application.report(runId);
      const [first] = report.lanes[0]!.candidates;
      const total = first?.judgement?.status === "judged" ? first.judgement.weightedTotal : 0;
      expect(total).toBeGreaterThanOrEqual(8.5);
      expect(total).toBeLessThan(9);
      expect(lanes[0]).toMatchObject({ stopReason: "iteration-limit", iterations: 2 });
      expect(report.stopRules).toMatchObject({ targetScore: 9 });
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Run's minimum improvement replaces the default: a 0.3 rise doesn't count at 0.5", async () => {
    // Iteration 2 raises Pose and Framing to level 5: 0.10 × 2.5 + 0.02 × 2.5 = 0.3 more.
    const better = { ...FAKE_VERDICT, levels: { ...levels(4), pose: 5, framing: 5 } };
    const { application } = await setup(["same", "same", "same"], {}, undefined, [
      FAKE_VERDICT,
      better,
    ]);
    try {
      const stopRules = { targetScore: 9.5, patience: 1, minImprovement: 0.5, maxIterations: 3 };
      const { lanes } = await application.start(loop({ stopRules }));
      expect(lanes[0]).toMatchObject({ stopReason: "patience", iterations: 2 });
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Run's Optimizer model and effort are the ones its calls are made with", async () => {
    const vendor = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify({ prompt: "A sharper headshot." })),
    );
    const { application } = await runApplication(
      fakeImageModels(["same", "same"]).layer,
      undefined,
      fakeJudges().layer,
      optimizersOnFakeAnthropic(vendor.origin),
    );
    try {
      const custom = { model: "anthropic/claude-haiku-5", effort: "high" } as const;
      const { runId } = await withEnvironment(
        { ANTHROPIC_API_KEY: "test-optimizer-key-0123456789" },
        () => application.start(loop({ optimizer: custom, ...rules({ maxIterations: 2 }) })),
      );
      expect(vendor.requests).toHaveLength(1);
      expect(JSON.parse(vendor.requests[0]!.body)).toMatchObject({
        model: "claude-haiku-5",
        output_config: { effort: "high" },
      });
      expect((await application.report(runId)).optimizer).toMatchObject(custom);
    } finally {
      await application.close();
      await vendor.stop();
    }
  }, 60_000);

  test("when optimizing fails, the next Iteration keeps the last Prompt and says why", async () => {
    const { application, fake } = await setup(["same", "same"], {}, undefined, [], {}, ["fail"]);
    try {
      const { runId } = await application.start(loop(rules({ maxIterations: 2 })));
      const [, second] = (await application.report(runId)).lanes[0]!.prompts;
      expect(second).toMatchObject({
        iteration: 2,
        prompt: initialPrompt(DEFAULT_TARGET_LOOK),
        source: "kept",
        reason: "fake Optimizer HTTP 400: bad request",
      });
      expect(fake.requests[1]!.prompt).toBe(initialPrompt(DEFAULT_TARGET_LOOK));
    } finally {
      await application.close();
    }
  }, 60_000);

  test("an Optimizer answer over 32,000 characters is never sent: the Prompt is kept and the call billed", async () => {
    const vendor = fakeVendorServer(() =>
      vendorAnswer("anthropic", JSON.stringify({ prompt: "x".repeat(32_001) })),
    );
    const fake = fakeImageModels(["same", "same"]);
    const { application } = await runApplication(
      fake.layer,
      undefined,
      fakeJudges().layer,
      optimizersOnFakeAnthropic(vendor.origin),
    );
    try {
      const key = "test-optimizer-key-0123456789";
      const { runId } = await withEnvironment({ ANTHROPIC_API_KEY: key }, () =>
        application.start(loop(rules({ maxIterations: 2 }))),
      );
      const [first, second] = (await application.report(runId)).lanes[0]!.prompts;
      expect(second).toMatchObject({
        prompt: initialPrompt(DEFAULT_TARGET_LOOK),
        source: "kept",
        reason: "The Optimizer's Prompt has 32001 characters, over the limit of 32000",
      });
      // Iteration 1's call: 9,000 input and 300 output tokens at the fake LLM price.
      expect(first!.optimizerCost).toMatchObject({ actualUsd: 0.004875, unknownCostCalls: 0 });
      expect(fake.requests[1]!.prompt).toBe(initialPrompt(DEFAULT_TARGET_LOOK));
      expect(vendor.requests).toHaveLength(1);
    } finally {
      await application.close();
      await vendor.stop();
    }
  }, 60_000);

  /** The Run's steps on a fresh runtime over its database, as after a restart. */
  const stepsOn = (
    databasePath: string,
    dataDirectory: string,
    script: FakeScript = [],
    store: Layer.Layer<RunStore, unknown> = LibsqlRunStore(databasePath),
  ) => {
    const images = fakeImageModels(script);
    const judge = fakeJudges();
    const optimizer = fakeOptimizers();
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        images.layer,
        judge.layer,
        optimizer.layer,
        realFaceEmbedder(),
        store,
        Layer.succeed(RunConfig)({
          ...defaultRunConfig(dataDirectory),
          photoPaths: "operator",
          retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
        }),
      ),
    );
    /** One Iteration, as its step re-executes it. */
    const iteration = (state: LaneState) => runtime.runPromise(runIteration(state));
    return { images, judge, optimizer, runtime, iteration };
  };

  test("an interrupt that lands while a call is being reserved leaves no reservation unsettled", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same"]);
    const { runId } = await application.start(loop(rules({ maxIterations: 1 })));
    await application.close();
    // Iteration 1 again from the start: its Candidate and records are gone.
    tamper(databasePath, "DELETE FROM judgements");
    tamper(databasePath, "DELETE FROM cost_records");
    tamper(databasePath, "DELETE FROM candidates");
    tamper(databasePath, "UPDATE lanes SET stop_reason = NULL");
    const reserved = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    // The store's reservation is written, then held before the step learns of it.
    const holding = Layer.effect(RunStore)(
      Effect.gen(function* () {
        const store = yield* RunStore;
        return {
          ...store,
          reserveCall: (...args: Parameters<typeof store.reserveCall>) =>
            store.reserveCall(...args).pipe(
              Effect.tap(() => Effect.sync(() => reserved.resolve())),
              Effect.tap(() => Effect.promise(() => held)),
            ),
        };
      }),
    ).pipe(Layer.provide(LibsqlRunStore(databasePath)));
    const again = stepsOn(databasePath, dataDirectory, ["same"], holding);
    try {
      const fiber = again.runtime.runFork(generateIteration(lane0Iteration1(runId)));
      await reserved.promise;
      const interrupted = again.runtime.runPromise(Fiber.interrupt(fiber));
      release();
      await interrupted;
      const report = await again.runtime.runPromise(runReport(runId));
      expect(report.unattributedCalls).toEqual([
        expect.objectContaining({ purpose: "generate", settled: true, actualUsd: 0 }),
      ]);
      expect(again.images.requests).toEqual([]);
    } finally {
      release();
      await again.runtime.dispose();
    }
  }, 60_000);

  test("re-executed Iterations find every record and bill nothing again", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same", "same"]);
    const { runId } = await application.start(loop(rules({ maxIterations: 2 })));
    const before = await application.report(runId);
    await application.close();
    // The process died before the Lane's stop was recorded.
    tamper(databasePath, "UPDATE lanes SET stop_reason = NULL");
    const again = stepsOn(databasePath, dataDirectory);
    try {
      const first = await again.iteration(lane0Iteration1(runId));
      expect(first).toEqual({ ...lane0Iteration1(runId), iteration: 2 });
      expect(await again.iteration(first)).toEqual({ ...first, stopReason: "iteration-limit" });
      // A Lane whose stop is recorded runs nothing more.
      expect(await again.iteration(lane0Iteration1(runId))).toEqual({
        ...lane0Iteration1(runId),
        stopReason: "iteration-limit",
      });
      expect(again.images.requests).toHaveLength(0);
      expect(again.judge.requests).toHaveLength(0);
      expect(again.optimizer.requests).toHaveLength(0);
      const after = await again.runtime.runPromise(runReport(runId));
      expect(after.lanes).toEqual(before.lanes);
      expect(after.totals).toEqual(before.totals);
    } finally {
      await again.runtime.dispose();
    }
  }, 60_000);

  test.each([
    {
      what: "an image call",
      // $0.19, 2 Candidates: the first $0.10 reservation fits, the second doesn't; once the
      // first settles at $0.08 and its Judge call at $0.005, $0.105 would fit it.
      script: ["same", "same"] as FakeScript,
      options: {},
      judgeOptions: {},
      budgetUsd: 0.19,
      candidates: 2,
    },
    {
      what: "a Judge call",
      // $0.105: the $0.10 image fits and settles at $0.08; the $0.03 Judge call doesn't fit.
      script: ["same"] as FakeScript,
      options: {},
      judgeOptions: { estimateMicros: 30_000 },
      budgetUsd: 0.105,
      candidates: 1,
    },
    {
      what: "an image retry",
      // $0.15: the first call's cost is unknown, so it keeps its $0.10; the retry doesn't fit.
      script: ["transient", "same"] as FakeScript,
      options: { transientCost: null },
      judgeOptions: {},
      budgetUsd: 0.15,
      candidates: 1,
    },
  ])(
    "a re-executed Iteration where $what didn't fit still stops the Lane, with no Optimizer call",
    async ({ script, options, judgeOptions, budgetUsd, candidates }) => {
      const { application, databasePath, dataDirectory } = await setup(
        script,
        options,
        undefined,
        [],
        judgeOptions,
      );
      const { runId, lanes } = await application.start(loop({ budgetUsd, candidates }));
      expect(lanes[0]).toMatchObject({ stopReason: "budget-exhausted", iterations: 1 });
      const before = await application.report(runId);
      await application.close();
      // The process died before the Lane's stop was recorded.
      tamper(databasePath, "UPDATE lanes SET stop_reason = NULL");
      const again = stepsOn(databasePath, dataDirectory, ["same"]);
      try {
        expect(await again.iteration(lane0Iteration1(runId))).toEqual({
          ...lane0Iteration1(runId),
          stopReason: "budget-exhausted",
        });
        const after = await again.runtime.runPromise(runReport(runId));
        expect(after.lanes[0]!.iterations).toBe(1);
        expect(after.totals).toEqual(before.totals);
      } finally {
        await again.runtime.dispose();
      }
    },
    60_000,
  );

  test("a re-executed Iteration whose Optimizer answer was lost calls it again, numbering on", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same", "same"]);
    const { runId } = await application.start(loop(rules({ maxIterations: 2 })));
    await application.close();
    // Iteration 1's Optimizer call was sent, but the process died before Iteration 2 existed.
    for (const table of ["judgements", "candidates"]) {
      tamper(databasePath, `DELETE FROM ${table} WHERE iteration = 2`);
    }
    tamper(databasePath, "DELETE FROM cost_records WHERE iteration = 2");
    tamper(databasePath, "DELETE FROM iterations WHERE iteration = 2");
    tamper(databasePath, "UPDATE lanes SET stop_reason = NULL");
    tamper(
      databasePath,
      `UPDATE cost_records SET settled = 0, actual_micros = NULL, usage = NULL, result = NULL
       WHERE purpose = 'optimize'`,
    );
    const again = stepsOn(databasePath, dataDirectory);
    try {
      expect(await again.iteration(lane0Iteration1(runId))).toMatchObject({ iteration: 2 });
      const report = await again.runtime.runPromise(runReport(runId));
      expect(
        report.lanes[0]!.prompts[0]!.optimizerCost.calls.map(({ attempt, settled }) => [
          attempt,
          settled,
        ]),
      ).toEqual([
        [0, false],
        [1, true],
      ]);
      expect(report.lanes[0]!.prompts.map(({ source }) => source)).toEqual([
        "initial",
        "optimizer",
      ]);
    } finally {
      await again.runtime.dispose();
    }
  }, 60_000);

  test("an Optimizer retry that doesn't fit the Budget isn't made, and the Lane stops", async () => {
    // $0.12: Iteration 1 spends $0.085; the $0.02 Optimizer call fits, fails at unknown cost
    // (so it keeps its $0.02), and its retry doesn't fit the $0.015 left.
    const { application } = await setup(["same"], {}, undefined, [], {}, [
      "transient-unknown-cost",
    ]);
    try {
      const { runId, lanes } = await application.start(loop({ budgetUsd: 0.12 }));
      expect(lanes[0]).toMatchObject({ stopReason: "budget-exhausted", iterations: 1 });
      const [first] = (await application.report(runId)).lanes[0]!.prompts;
      expect(first!.optimizerCost).toMatchObject({
        unknownCostCalls: 1,
        calls: [expect.objectContaining({ attempt: 0, result: "transient" })],
      });
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a re-executed generate phase makes only the call whose Candidate was lost, numbering on", async () => {
    const { application, databasePath, dataDirectory } = await setup(["same", "same", "same"]);
    const { runId } = await application.start(
      loop({ candidates: 2, ...rules({ maxIterations: 1 }) }),
    );
    await application.close();
    // Candidate 1's image call was sent but the process died before its Candidate was saved.
    tamper(databasePath, "DELETE FROM judgements WHERE candidate = 1");
    tamper(databasePath, "DELETE FROM cost_records WHERE candidate = 1 AND purpose = 'judge'");
    tamper(databasePath, "DELETE FROM candidates WHERE candidate = 1");
    tamper(
      databasePath,
      `UPDATE cost_records SET settled = 0, actual_micros = NULL, usage = NULL, result = NULL
       WHERE candidate = 1 AND purpose = 'generate'`,
    );
    const again = stepsOn(databasePath, dataDirectory, ["same"]);
    try {
      await again.runtime.runPromise(generateIteration(lane0Iteration1(runId)));
      expect(again.images.requests).toHaveLength(1);
      const report = await again.runtime.runPromise(runReport(runId));
      const [first, second] = report.lanes[0]!.candidates;
      expect(first!.calls.map(({ attempt }) => attempt)).toEqual([0]);
      expect(second!.calls.map(({ attempt, settled }) => [attempt, settled])).toEqual([
        [0, false],
        [1, true],
      ]);
    } finally {
      await again.runtime.dispose();
    }
  }, 60_000);

  /** Start a Run through Mastra's own run, so a test can cancel it. */
  const startCancellable = async (
    application: Awaited<ReturnType<typeof runApplication>>["application"],
    input: RunRequest,
  ) => {
    const run = await application.mastra.getWorkflow("run").createRun();
    const started = run.start({ inputData: input });
    return { run, started };
  };
  /** Waits until every Lane of the Run has a stored stop reason; returns the report. */
  const untilStopped = async (
    application: Awaited<ReturnType<typeof runApplication>>["application"],
    databasePath: string,
    runId: string,
  ) => {
    await until(
      async () => storedStopReasons(databasePath, runId).every((reason) => reason !== null),
      { timeoutMs: 10_000 },
    );
    return application.report(runId);
  };

  test("cancelling while the Run is being prepared, with no Iteration running, stops every Lane", async () => {
    const { application, databasePath, fake } = await setup(["same", "same"]);
    try {
      const run = await application.mastra.getWorkflow("run").createRun();
      const stream = run.stream({
        inputData: loop({ lanes: [{ model: OPENAI_IMAGE_MODEL }, { model: GEMINI_IMAGE_MODEL }] }),
      });
      // The estimate is `prepare`'s last act, after it stored the Lanes; cancel right then.
      for await (const chunk of stream.fullStream) {
        if (chunk.type !== "workflow-step-output") continue;
        const output = chunk.payload.output as { event?: unknown } | undefined;
        if (output?.event === "estimate") await run.cancel();
      }
      await stream.result;
      await until(async () => !storedStopReasons(databasePath, run.runId).includes(null), {
        timeoutMs: 10_000,
      });
      expect(storedStopReasons(databasePath, run.runId)).toEqual(["cancelled", "cancelled"]);
      expect(fake.requests).toEqual([]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Run cancelled right before the application closes still stores its Lanes cancelled", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { application, databasePath, fake } = await setup(["same"], {
      beforeAnswer: () => held,
    });
    let closed = false;
    try {
      const { run, started } = await startCancellable(application, loop());
      started.catch(() => undefined);
      await until(async () => fake.requests.length === 1, { timeoutMs: 20_000 });
      await run.cancel();
      await application.close();
      closed = true;
      expect(storedStopReasons(databasePath, run.runId)).toEqual(["cancelled"]);
    } finally {
      release();
      if (!closed) await application.close();
    }
  }, 60_000);

  test("a Run Mastra stored as cancelled reports its unrecorded Lanes cancelled", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { application, databasePath, dataDirectory, fake } = await setup(["same"], {
      beforeAnswer: () => held,
    });
    try {
      const { run, started } = await startCancellable(application, loop());
      await until(async () => fake.requests.length === 1, { timeoutMs: 20_000 });
      await run.cancel();
      await started;
      // The process stopped before the cancel was recorded.
      tamper(databasePath, "UPDATE lanes SET stop_reason = NULL");
      expect((await application.report(run.runId)).lanes[0]!.stopReason).toBe("cancelled");
      const read = await readRunReport(databasePath, dataDirectory, run.runId);
      expect(read.lanes[0]!.stopReason).toBe("cancelled");
    } finally {
      release();
      await application.close();
    }
  }, 60_000);

  test("cancelling stops only the Lanes still running; a Lane that already stopped keeps its reason", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { application, databasePath, fake } = await setup(
      { [GEMINI_IMAGE_MODEL]: ["refuse", "refuse"], [OPENAI_IMAGE_MODEL]: ["same"] },
      {
        beforeAnswer: async (_, model) => {
          if (model === OPENAI_IMAGE_MODEL) await held;
        },
      },
    );
    try {
      const { run, started } = await startCancellable(
        application,
        loop({ lanes: [{ model: GEMINI_IMAGE_MODEL }, { model: OPENAI_IMAGE_MODEL }] }),
      );
      // The Gemini Lane stops on repeated refusals while the OpenAI Lane's call is held.
      await until(
        async () =>
          fake.requests.length === 3 && storedStopReasons(databasePath, run.runId)[0] !== null,
        { timeoutMs: 20_000 },
      );
      await run.cancel();
      await started;
      const report = await untilStopped(application, databasePath, run.runId);
      expect(report.lanes.map(({ stopReason }) => stopReason)).toEqual([
        "repeated-failures",
        "cancelled",
      ]);
    } finally {
      release();
      await application.close();
    }
  }, 60_000);

  test("cancelling stops Lanes still waiting their turn, which never ran", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { application, databasePath, fake } = await setup(
      Array.from({ length: 5 }, () => "same" as const),
      {
        beforeAnswer: () => held,
      },
    );
    try {
      const lanes = Array.from({ length: LANE_CONCURRENCY + 1 }, () => ({
        model: OPENAI_IMAGE_MODEL,
      }));
      const { run, started } = await startCancellable(application, loop({ lanes }));
      await until(async () => fake.requests.length === LANE_CONCURRENCY, { timeoutMs: 20_000 });
      await run.cancel();
      await started;
      const report = await untilStopped(application, databasePath, run.runId);
      expect(report.lanes.map(({ stopReason }) => stopReason)).toEqual(
        lanes.map(() => "cancelled"),
      );
      // The last Lane never ran: no call, no Candidate.
      expect(report.lanes.at(-1)!.candidates).toEqual([]);
      expect(fake.requests).toHaveLength(LANE_CONCURRENCY);
    } finally {
      release();
      await application.close();
    }
  }, 60_000);

  test("cancelling while the Optimizer's request is in flight aborts it and settles it at unknown cost", async () => {
    const aborted: boolean[] = [];
    const vendor = fakeVendorServer((request) => {
      // Answers only when the request is aborted.
      const { promise, resolve } = Promise.withResolvers<Response>();
      request.signal.addEventListener("abort", () => {
        aborted.push(true);
        resolve(new Response(null, { status: 499 }));
      });
      return promise;
    });
    const { application, databasePath } = await runApplication(
      fakeImageModels(["same"]).layer,
      undefined,
      fakeJudges().layer,
      optimizersOnFakeAnthropic(vendor.origin),
    );
    try {
      await withEnvironment({ ANTHROPIC_API_KEY: "test-optimizer-key-0123456789" }, async () => {
        const { run, started } = await startCancellable(application, loop());
        await until(async () => vendor.requests.length === 1, { timeoutMs: 20_000 });
        await run.cancel();
        await started;
        const report = await untilStopped(application, databasePath, run.runId);
        expect(report.lanes[0]!.stopReason).toBe("cancelled");
        await until(async () => aborted.length === 1, { timeoutMs: 10_000 });
        await until(
          async () =>
            (await application.report(run.runId)).lanes[0]!.prompts[0]!.optimizerCost.calls[0]
              ?.settled === true,
          { timeoutMs: 10_000 },
        );
        const [first] = (await application.report(run.runId)).lanes[0]!.prompts;
        expect(first!.optimizerCost.calls).toEqual([
          expect.objectContaining({ result: "transient", actualUsd: null }),
        ]);
      });
    } finally {
      await application.close();
      await vendor.stop();
    }
  }, 60_000);

  test("each Lane's Optimizer sees only its own Lane's Candidates, and each Lane stops on its own", async () => {
    const { application, optimizer } = await setup({
      [GEMINI_IMAGE_MODEL]: ["refuse", "refuse"],
      [OPENAI_IMAGE_MODEL]: ["same", "same", "same"],
    });
    try {
      const { lanes } = await application.start(
        loop({
          lanes: [
            { model: GEMINI_IMAGE_MODEL, prompt: "Lane A's Prompt" },
            { model: OPENAI_IMAGE_MODEL, prompt: "Lane B's Prompt" },
          ],
          ...rules({ maxIterations: 3 }),
        }),
      );
      expect(lanes.map(({ stopReason }) => stopReason)).toEqual([
        "repeated-failures",
        "iteration-limit",
      ]);
      const outcomesSeen = (laneFirstPrompt: string) =>
        optimizer.requests
          .filter(({ history }) => history[0]!.prompt === laneFirstPrompt)
          .flatMap(({ history }) =>
            history.flatMap(({ candidates }) => candidates.map(({ outcome }) => outcome?._tag)),
          );
      expect(new Set(outcomesSeen("Lane A's Prompt"))).toEqual(new Set(["Refused"]));
      expect(new Set(outcomesSeen("Lane B's Prompt"))).toEqual(new Set(["Scored"]));
    } finally {
      await application.close();
    }
  }, 60_000);

  /** The real Optimizers without any key, recording their price lookups. */
  const keylessOptimizers = (lookups: string[]) =>
    MastraOptimizers({
      env: {},
      prices: {
        lookup: (model) =>
          Effect.sync(() => {
            lookups.push(model);
            return fakeLlmPrice(model);
          }),
      },
    });

  test("a missing Optimizer key fails the Run before any price is looked up", async () => {
    const lookups: string[] = [];
    const judge = fakeJudges();
    const { application } = await runApplication(
      fakeImageModels([]).layer,
      undefined,
      judge.layer,
      keylessOptimizers(lookups),
    );
    try {
      await expect(application.start(loop())).rejects.toThrow("ANTHROPIC_API_KEY is not set");
      expect(lookups).toEqual([]);
      // Not even the Judge's price.
      expect(judge.gets).toEqual([]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("a Run of one Iteration needs no Optimizer key: it never calls the Optimizer", async () => {
    const lookups: string[] = [];
    const { application } = await runApplication(
      fakeImageModels(["same"]).layer,
      undefined,
      fakeJudges().layer,
      keylessOptimizers(lookups),
    );
    try {
      const { runId, lanes } = await application.start(
        loop({
          judge: { ...DEFAULT_JUDGE, model: "openai/gpt-5.5" },
          ...rules({ maxIterations: 1 }),
        }),
      );
      expect(lanes[0]).toMatchObject({ stopReason: "iteration-limit", iterations: 1 });
      expect(lookups).toEqual([]);
      expect((await application.report(runId)).optimizer).not.toHaveProperty("price");
    } finally {
      await application.close();
    }
  }, 60_000);
});

describe("Run engine with the real adapters and a scripted network", () => {
  const SENTINEL = "SENTINEL-KEY-0123456789";

  test("with 5 accepted photos it sends at most 4 references at 2K and stores the key nowhere", async () => {
    const bodies: string[] = [];
    const recorded = await recordedGemini("completed-image.json");
    const layer = NativeImageModels({
      prices: { lookup: () => Effect.succeed(price) },
      env: { GEMINI_API_KEY: SENTINEL },
      geminiFetch: async (_, init) => {
        bodies.push(String(init.body));
        return new Response(recorded, { status: 200 });
      },
    });
    const { application, databasePath } = await runApplication(layer);
    try {
      const photos = [
        "biden-2022.jpg",
        "biden-2013.jpg",
        "biden-2021.jpg",
        "biden-2021.heic",
        "obama-biden-2015.jpg",
      ].map(faceFixture);
      // Photo 5 is a group photo; face 2 (on the right) is the Subject.
      const { runId } = await application.start(
        request({ photos, faceChoices: [{ photo: 5, face: 2 }], candidates: 2 }),
      );
      const report = await application.report(runId);
      expect(report.referencePhotos.photos.map(({ verdict }) => verdict)).toEqual(
        Array(5).fill("accepted"),
      );
      expect(report.lanes[0]!.characterReferences).toHaveLength(4);
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        const sent = JSON.parse(body);
        expect(sent.input.filter((part: { type: string }) => part.type === "image")).toHaveLength(
          4,
        );
        expect(sent.response_format).toMatchObject({ image_size: "2K", delivery: "inline" });
      }
      // The recorded image is a plain synthetic square: no face.
      expect(report.lanes[0]!.candidates.map(({ outcome }) => outcome)).toEqual(["Gated", "Gated"]);
      const snapshot = JSON.stringify(await application.snapshot(runId));
      await application.close();
      for (const text of [
        snapshot,
        JSON.stringify(report),
        await Bun.file(databasePath).text(),
        (await Bun.file(`${databasePath}-wal`).exists())
          ? await Bun.file(`${databasePath}-wal`).text()
          : "",
      ]) {
        expect(text).not.toContain(SENTINEL);
      }
    } finally {
      await application.close().catch(() => {});
    }
  }, 60_000);

  test("generation prices calls at the Lane's recorded price, not a later lookup", async () => {
    const recorded = await recordedGemini("completed-image.json");
    // Only the first lookup (at Run start) gets the real price, from stale LiteLLM data;
    // any later one is 10× dearer.
    let lookups = 0;
    const recordedPrice: PriceQuote = {
      ...price,
      source: {
        _tag: "litellm",
        asOf: "2026-10-30T00:00:00.000Z",
        ageSeconds: 172_800,
        stale: true,
      },
    };
    const tenfold = {
      ...price,
      pricing: Object.fromEntries(
        Object.entries(price.pricing).map(([k, v]) => [k, typeof v === "number" ? v * 10 : v]),
      ) as PriceQuote["pricing"],
    };
    const layer = NativeImageModels({
      prices: { lookup: () => Effect.sync(() => (lookups++ === 0 ? recordedPrice : tenfold)) },
      env: { GEMINI_API_KEY: SENTINEL },
      geminiFetch: async () => new Response(recorded, { status: 200 }),
    });
    const { application } = await runApplication(layer);
    try {
      const { runId } = await application.start(request({ candidates: 1 }));
      const report = await application.report(runId);
      expect(lookups).toBe(1);
      // The fixture's usage at the recorded price: 2600 input × 1.5e-6 + 1680 image × 3e-5
      // + (10 text + 290 thought) × 7.5e-6 = $0.05655.
      expect(report.totals.actualUsd).toBe(0.05655);
      expect(report.totals.estimatedUsd).toBeLessThan(0.2);
      // The stdout report says where the price came from and how old it was.
      expect(report.lanes[0]!.price).toEqual({
        source: "litellm",
        asOf: "2026-10-30T00:00:00.000Z",
        ageSeconds: 172_800,
        stale: true,
      });
    } finally {
      await application.close();
    }
  }, 60_000);

  test("an OpenAI Lane beside a Gemini Lane sends up to 16 references, costs calls from usage and stores no key", async () => {
    const OPENAI_SENTINEL = "sk-SENTINEL-KEY-0123456789";
    const geminiRecorded = await recordedGemini("completed-image.json");
    const openaiRecorded = await recordedOpenAI("image-with-usage.json");
    const openaiBodies: string[] = [];
    const prices: Record<string, PriceQuote> = {
      [price.model]: price,
      [openaiPrice.model]: openaiPrice,
    };
    const layer = NativeImageModels({
      prices: { lookup: (model) => Effect.succeed(prices[model]!) },
      env: { GEMINI_API_KEY: SENTINEL, OPENAI_API_KEY: OPENAI_SENTINEL },
      geminiFetch: async () => new Response(geminiRecorded, { status: 200 }),
      openaiFetch: async (_, init) => {
        openaiBodies.push(String(init.body));
        return new Response(openaiRecorded, { status: 200 });
      },
    });
    const { application, databasePath } = await runApplication(layer);
    try {
      const { runId } = await application.start(
        request({
          ...fivePhotos,
          candidates: 1,
          lanes: [{ model: price.model }, { model: openaiPrice.model }],
        }),
      );
      const report = await application.report(runId);
      const [gemini, openai] = report.lanes;
      expect(gemini!.characterReferences).toHaveLength(4);
      expect(openai!.characterReferences).toHaveLength(5);
      expect(openaiBodies).toHaveLength(1);
      expect(JSON.parse(openaiBodies[0]!)).toMatchObject({
        model: openaiPrice.model,
        quality: "high",
        size: "1024x1024",
        n: 1,
        images: Array(5).fill({ image_url: expect.stringMatching(/^data:image\/jpeg;base64,/) }),
      });
      // The fixture's usage: 120 text × $5/M + 6300 image × $8/M + 1756 output × $30/M.
      expect(openai!.candidates[0]!.calls[0]).toMatchObject({
        result: "image",
        actualUsd: 0.10368,
      });
      expect(openai!.actualUsd).toBe(0.10368);
      const snapshot = JSON.stringify(await application.snapshot(runId));
      await application.close();
      for (const text of [
        snapshot,
        JSON.stringify(report),
        await Bun.file(databasePath).text(),
        (await Bun.file(`${databasePath}-wal`).exists())
          ? await Bun.file(`${databasePath}-wal`).text()
          : "",
      ]) {
        expect(text).not.toContain(OPENAI_SENTINEL);
        expect(text).not.toContain(SENTINEL);
      }
    } finally {
      await application.close().catch(() => {});
    }
  }, 60_000);
});
