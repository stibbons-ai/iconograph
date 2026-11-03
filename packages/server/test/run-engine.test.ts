import { describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorLine, imagePath, NativeImageModels } from "@iconograph/adapters";
import {
  DEFAULT_TARGET_LOOK,
  type ImageModels,
  initialPrompt,
  type PriceQuote,
  type RunRequest,
} from "@iconograph/domain";
import { Effect, type Layer } from "effect";
import { realFaceEmbedder } from "../../adapters/test/face-models";
import { geminiTestPrice as price, recordedGemini } from "../../adapters/test/gemini-fixtures";
import {
  openaiTestPrice as openaiPrice,
  recordedOpenAI,
} from "../../adapters/test/openai-fixtures";
import { tamper } from "../../adapters/test/tamper";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import { createRunApplication, readRunReport, type RunWarning } from "../src";
import {
  FAKE_ACTUAL_MICROS,
  FAKE_ESTIMATE_MICROS,
  faceFixture,
  type FakeOptions,
  type FakeScript,
  fakeImageModels,
  subjectPhotos,
} from "./support/fake-image-models";

const temporaryDirectory = temporaryDirectories("run");

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  photos: subjectPhotos,
  faceChoices: [],
  pins: [],
  targetLook: DEFAULT_TARGET_LOOK,
  budgetUsd: 5,
  candidates: 3,
  lanes: [{ model: "gemini-nano-banana-2.1" }],
  ...overrides,
});

/** Root reads and writes through any permission, so chmod-based faults can't be staged. */
const asRoot = process.getuid?.() === 0;

/** A Run application on a fresh database and data volume. */
async function runApplication(
  imageModels: Layer.Layer<ImageModels>,
  warn?: (warning: RunWarning) => void,
) {
  const directory = await temporaryDirectory();
  const dataDirectory = join(directory, "data");
  const databasePath = join(directory, "runs.db");
  const app = await createRunApplication({
    databasePath,
    dataDirectory,
    imageModels,
    faceEmbedder: realFaceEmbedder(),
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
    ...(warn && { warn }),
  });
  return { application: app, dataDirectory, databasePath };
}

/** The same, with the fake Image Model. */
async function setup(
  script: FakeScript,
  options: FakeOptions = {},
  warn?: (warning: RunWarning) => void,
) {
  const fake = fakeImageModels(script, options);
  return { ...(await runApplication(fake.layer, warn)), fake };
}

describe("Run engine with a fake Image Model", () => {
  test("records each Candidate Outcome with Likeness, reasons, files and costs", async () => {
    const { application, fake } = await setup(["same", "different", "no-face", "refuse", "fail"]);
    try {
      const events: unknown[] = [];
      const result = await application.start(request({ candidates: 5 }), (event) =>
        events.push(event),
      );
      expect(result.lanes).toEqual([
        { runId: result.runId, lane: 0, stopReason: "iteration-limit" },
      ]);
      // The estimate came before any call: N first calls at the per-call estimate.
      expect(events).toEqual([
        expect.objectContaining({ event: "estimate", estimatedUsd: 0.5, budgetUsd: 5 }),
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
      expect(report.totals).toMatchObject({
        estimatedUsd: 0.5,
        actualUsd: (3 * FAKE_ACTUAL_MICROS) / 1e6,
        unknownCostCalls: 0,
        remainingUsd: 5 - (3 * FAKE_ACTUAL_MICROS) / 1e6,
      });
      expect(report.referencePhotos.warnings.map(({ code }) => code)).toEqual(["few-photos"]);
      expect([...lane!.characterReferences].sort()).toEqual([1, 2]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("step outputs and the persisted snapshot carry ids, not image bytes or embeddings", async () => {
    const { application } = await setup(["same"]);
    try {
      const { runId } = await application.start(request({ candidates: 1 }));
      const snapshot = await application.snapshot(runId);
      const steps = snapshot.context as Record<string, { output?: unknown }>;
      expect(steps.prepare?.output).toEqual([{ runId, lane: 0, model: "gemini-nano-banana-2.1" }]);
      expect(steps.finish?.output).toEqual({
        runId,
        lanes: [{ runId, lane: 0, stopReason: "iteration-limit" }],
      });
      const text = JSON.stringify(snapshot);
      // No base64 image payloads (JPEG starts /9j/) and no 128-d embedding arrays.
      expect(text).not.toContain("/9j/");
      expect(text).not.toMatch(/\[(-?\d+\.\d+,){100,}/);
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
      expect(report.lanes[0]!.candidates).toHaveLength(2);
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
      expect(report.totals.estimatedUsd).toBeLessThanOrEqual(0.4);
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

  test("a Budget below one call makes no call, stops the Lane and reports an empty Lane", async () => {
    const { application, fake } = await setup(["same"]);
    try {
      const { runId, lanes } = await application.start(request({ budgetUsd: 0.05 }));
      expect(fake.requests).toHaveLength(0);
      expect(lanes[0]!.stopReason).toBe("budget-exhausted");
      const report = await application.report(runId);
      expect(report.lanes[0]!.candidates).toEqual([]);
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
          await new Promise<void>((resolve) => {
            const resolveOnceStored = () =>
              void Bun.file(unreadable)
                .exists()
                .then((stored) => {
                  if (!stored) return;
                  watcher.close();
                  resolve();
                });
            const watcher = watch(dirname(unreadable), resolveOnceStored);
            resolveOnceStored();
          });
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
      expect(lanes).toEqual([
        { runId, lane: 0, stopReason: "iteration-limit" },
        { runId, lane: 1, stopReason: "iteration-limit" },
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
      expect(gemini).toMatchObject({ model: GEMINI, initialPrompt: geminiPrompt });
      expect([...gemini!.characterReferences].sort()).toEqual([1, 3]);
      expect(gemini!.candidates.map(({ outcome }) => outcome)).toEqual(["Scored", "Refused"]);
      expect(openai).toMatchObject({ model: OPENAI, initialPrompt: sentTo(OPENAI)[0]!.prompt });
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
      expect(report.lanes.flatMap(({ candidates }) => candidates)).toHaveLength(3);
      // A Lane that got fewer than its two Candidates stopped for the Budget.
      for (const lane of report.lanes) {
        const stopReason = lane.candidates.length < 2 ? "budget-exhausted" : "iteration-limit";
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

  test("the estimate prices each Lane's calls with that Lane's own Prompt", async () => {
    const events: unknown[] = [];
    // One micro-dollar per Prompt character, so the estimate shows which Prompt was used.
    const { application } = await setup(["same", "same"], {
      estimateMicros: ({ prompt }) => prompt.length,
    });
    try {
      const own = "A studio headshot.";
      await application.start(
        request({ candidates: 1, lanes: [{ model: GEMINI, prompt: own }, { model: OPENAI }] }),
        (event) => events.push(event),
      );
      const defaultLength = initialPrompt(DEFAULT_TARGET_LOOK).length;
      expect(events).toEqual([
        expect.objectContaining({
          lanes: [
            expect.objectContaining({ lane: 0, perCallUsd: own.length / 1e6 }),
            expect.objectContaining({ lane: 1, perCallUsd: defaultLength / 1e6 }),
          ],
        }),
      ]);
    } finally {
      await application.close();
    }
  }, 60_000);

  test("read shows each Lane's stored Prompt, and null for a Lane that lost its Iteration (died mid-prepare)", async () => {
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
      const stored = (await application.report(runId)).lanes.map(
        ({ initialPrompt }) => initialPrompt,
      );
      expect(stored).toEqual([own, initialPrompt(look)]);
      // The report reads what was stored (and sent), not a Prompt rebuilt from today's template.
      await tamper(databasePath, "UPDATE iterations SET prompt = 'as sent' WHERE lane = 1");
      await tamper(databasePath, "DELETE FROM iterations WHERE lane = 0");
      const report = await application.report(runId);
      expect(report.lanes.map(({ initialPrompt }) => initialPrompt)).toEqual([null, "as sent"]);
      // Any other fault reading a Prompt still fails `read`, rather than showing null. The table is
      // renamed with the application closed, and `read` opens its own read-only connection (which
      // creates no tables), so every platform sees the schema change.
      await application.close();
      await tamper(databasePath, "ALTER TABLE iterations RENAME TO iterations_moved");
      await expect(readRunReport(databasePath, dataDirectory, runId)).rejects.toThrow(
        "Loading the Prompt of Iteration 1 failed",
      );
    } finally {
      await application.close().catch(() => {});
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
