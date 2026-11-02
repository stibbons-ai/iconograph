import { describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  byCriterion,
  checkBudget,
  DEFAULT_JUDGE,
  DEFAULT_TARGET_LOOK,
  DEFAULT_WEIGHTS,
  JUDGED_CRITERIA,
  type LedgerEntry,
  RUBRIC_V1,
  type RunRequest,
  scoreVerdict,
  type SettledCall,
  toMicros,
} from "@iconograph/domain";
import { Effect, type Layer, ManagedRuntime } from "effect";
import { LibsqlRunStore, RunStore, type RunPhotoReport } from "../src/run-store";
import { tamper } from "./tamper";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("run-store");

const request = (budgetUsd: number): RunRequest => ({
  photos: ["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
  faceChoices: [],
  pins: [],
  targetLook: DEFAULT_TARGET_LOOK,
  budgetUsd,
  candidates: 3,
  lanes: [{ model: "fake" }],
  judge: DEFAULT_JUDGE,
});

const face = { face: 1, box: { x: 0, y: 0, width: 10, height: 10 }, score: 0.9 };
const summary = (photo: number) => ({
  photo,
  path: `${photo}.jpg`,
  format: "jpeg" as const,
  width: 10,
  height: 10,
});
/** A report with every verdict: two accepted (one compared), one rejected, one flagged. */
const photoReport: RunPhotoReport = {
  model: "fake",
  identityGate: 0.4,
  photos: [
    {
      ...summary(1),
      verdict: "accepted",
      face,
      similarity: 0.7,
      similarityTo: "accepted-anchor",
      stored: { path: "a.jpg", sha256: "a" },
    },
    {
      ...summary(2),
      verdict: "accepted",
      face,
      similarity: 0.7,
      similarityTo: "accepted-anchor",
      stored: { path: "b.jpg", sha256: "b" },
    },
    { ...summary(3), verdict: "rejected", reason: "no-face" },
    {
      ...summary(4),
      verdict: "flagged",
      reason: "not-the-same-person",
      face,
      similarity: 0.1,
      similarityTo: "accepted-anchor",
    },
  ],
  identity: { photos: [1, 2], anchor: [1, 0], ceiling: { value: 0.7, source: "median-pairwise" } },
  warnings: [{ code: "few-photos", message: "Only 2 accepted Reference Photos" }],
};

/** Run `use` with the store. */
const withStore = <A, E>(use: (store: RunStore["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* RunStore);
  });

/** Create a Run with this Budget, Lane 0 and Iteration 1. */
const createRun = (runId: string, budgetUsd: number) =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.createRun({ id: runId, request: request(budgetUsd), photoReport });
      yield* store.createLane(runId, {
        lane: 0,
        model: "fake",
        price: {
          model: "fake",
          pricing: { _tag: "Llm", inputPerToken: 0, outputPerToken: 0 },
          source: { _tag: "override", asOf: "2026-11-02T00:00:00.000Z", ageSeconds: 0 },
        },
        characterReferences: [1],
      });
      yield* store.createIteration({ runId, lane: 0, iteration: 1 }, "prompt");
    }),
  );

/** A store on a fresh database holding Run "run" with this Budget. */
async function storeWithRun(budgetUsd: number) {
  const databasePath = join(await temporaryDirectory(), "runs.db");
  const runtime = ManagedRuntime.make(LibsqlRunStore(databasePath) as Layer.Layer<RunStore>);
  const run = <A, E>(effect: Effect.Effect<A, E, RunStore>) => runtime.runPromise(effect);
  await run(createRun("run", budgetUsd));
  return { runtime, run, databasePath };
}

const key = (
  candidate: number,
  attempt = 0,
  runId = "run",
  purpose: "generate" | "judge" = "generate",
) => ({ runId, lane: 0, iteration: 1, candidate, purpose, attempt });
const estimate = (micros: number) => ({ micros, usage: {} });
const settled = (costMicros: number | null): SettledCall => ({
  kind: "transient",
  reason: "test",
  costMicros,
});
/** Whether `reserveCall` admitted the call. */
const reserve = (candidate: number, micros: number, attempt = 0, runId = "run") =>
  withStore((store) =>
    store.reserveCall(key(candidate, attempt, runId), "fake", estimate(micros)).pipe(
      Effect.as(true),
      Effect.catchTag("BudgetExhausted", () => Effect.succeed(false)),
    ),
  );
const settle = (candidate: number, costMicros: number | null, attempt = 0, runId = "run") =>
  withStore((store) => store.settleCall(key(candidate, attempt, runId), settled(costMicros)));
const ledger = (runId = "run") =>
  withStore((store) => store.loadRecords(runId)).pipe(Effect.map(({ calls }) => calls));

describe("RunStore Budget ledger", () => {
  test("concurrent reservations and settles never overspend, never hit SQLITE_BUSY, and stay fast", async () => {
    // Budget $1.00, calls estimated at $0.10: 10 fit.
    const { runtime, run } = await storeWithRun(1);
    try {
      // Five calls are in flight; settling them (at $0.10 each) interleaves with 20 reservations.
      for (let candidate = 0; candidate < 5; candidate++) {
        expect(await run(reserve(candidate, 100_000))).toBe(true);
      }
      const started = performance.now();
      const results = await run(
        Effect.all(
          [
            ...Array.from({ length: 20 }, (_, index) => reserve(10 + index, 100_000)),
            ...Array.from({ length: 5 }, (_, candidate) =>
              settle(candidate, 100_000).pipe(Effect.as(null)),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      );
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(results.filter((result) => result === true)).toHaveLength(5);
      const calls = await run(ledger());
      expect(calls).toHaveLength(10);
      expect(calls.reduce((sum, call) => sum + call.estimateMicros, 0)).toBe(toMicros(1));
    } finally {
      await runtime.dispose();
    }
  });

  test("a missed reservation racing a settle that frees the Budget is admitted or exhausted, never a store error", async () => {
    // Repeated: the Budget is fully reserved, then a call that doesn't fit races a settle
    // that frees enough for it.
    for (let round = 0; round < 25; round++) {
      const { runtime, run } = await storeWithRun(0.2);
      try {
        await run(reserve(0, 100_000));
        await run(reserve(1, 100_000));
        const [outcome] = await run(
          Effect.all(
            [
              withStore((store) => store.reserveCall(key(0, 1), "fake", estimate(90_000))).pipe(
                Effect.result,
              ),
              settle(1, 0),
            ],
            { concurrency: "unbounded" },
          ),
        );
        if (outcome._tag === "Failure") {
          expect(outcome.failure._tag).toBe("BudgetExhausted");
        } else {
          // An admitted call wrote its row.
          const calls = await run(ledger());
          expect(calls.some((call) => call.candidate === 0 && call.attempt === 1)).toBe(true);
        }
      } finally {
        await runtime.dispose();
      }
    }
  });

  test("the SQL reservation agrees with the domain's checkBudget on the same ledger", async () => {
    // Run "run": settled $0.03, settled at $0 (an unbilled error), settled with unknown cost
    // (counts its $0.10), and one in flight at $0.05. Remaining: 0.30 − 0.03 − 0 − 0.10 − 0.05 = 0.12.
    const entries: LedgerEntry[] = [
      { estimateMicros: 100_000, settled: true, actualMicros: 30_000 },
      { estimateMicros: 100_000, settled: true, actualMicros: 0 },
      { estimateMicros: 100_000, settled: true, actualMicros: null },
      { estimateMicros: 50_000, settled: false, actualMicros: null },
    ];
    for (const micros of [0, 119_999, 120_000, 120_001, 300_000]) {
      const { runtime, run } = await storeWithRun(0.3);
      try {
        // Another Run in the same database spends heavily; it must not count.
        await run(createRun("other", 1));
        await run(reserve(0, 900_000, 0, "other"));
        await run(reserve(0, 100_000));
        await run(settle(0, 30_000));
        await run(reserve(1, 100_000));
        await run(settle(1, 0));
        await run(reserve(2, 100_000));
        await run(settle(2, null));
        await run(reserve(3, 50_000));
        const admitted = await run(reserve(4, micros));
        expect(admitted).toBe(checkBudget(toMicros(0.3), entries, micros).fits);
      } finally {
        await runtime.dispose();
      }
    }
  });

  test("a call that cost more than its estimate leaves nothing, not a negative, remaining", async () => {
    const { runtime, run } = await storeWithRun(0.1);
    try {
      await run(reserve(0, 50_000));
      await run(settle(0, 300_000));
      const overshoot: LedgerEntry[] = [
        { estimateMicros: 50_000, settled: true, actualMicros: 300_000 },
      ];
      for (const micros of [0, 1]) {
        expect(await run(reserve(1, micros))).toBe(
          checkBudget(toMicros(0.1), overshoot, micros).fits,
        );
      }
    } finally {
      await runtime.dispose();
    }
  });

  test("a Candidate's generate and judge calls are separate ledger rows, both counted", async () => {
    const { runtime, run } = await storeWithRun(0.25);
    try {
      expect(await run(reserve(0, 100_000))).toBe(true);
      const judge = (micros: number) =>
        withStore((store) =>
          store.reserveCall(key(0, 0, "run", "judge"), "judge-model", estimate(micros)),
        ).pipe(Effect.result);
      expect((await run(judge(100_000)))._tag).toBe("Success");
      await run(
        withStore((store) =>
          store.settleCall(key(0, 0, "run", "judge"), { kind: "judged", costMicros: 30_000 }),
        ),
      );
      const calls = await run(ledger());
      expect(calls.map(({ purpose, attempt, result }) => [purpose, attempt, result])).toEqual([
        ["generate", 0, null],
        ["judge", 0, "judged"],
      ]);
      // $0.25 − $0.10 reserved − $0.03 actual leaves $0.12: a second $0.15 judge call doesn't fit.
      const second = await run(
        withStore((store) =>
          store.reserveCall(key(0, 1, "run", "judge"), "judge-model", estimate(150_000)),
        ).pipe(Effect.flip),
      );
      expect(second).toMatchObject({ _tag: "BudgetExhausted", remainingMicros: 120_000 });
    } finally {
      await runtime.dispose();
    }
  });

  test("a call that doesn't fit fails with BudgetExhausted naming the remaining Budget, and records nothing", async () => {
    const { runtime, run } = await storeWithRun(0.15);
    try {
      expect(await run(reserve(0, 100_000))).toBe(true);
      const error = await run(
        Effect.flip(withStore((store) => store.reserveCall(key(1), "fake", estimate(100_000)))),
      );
      expect(error).toMatchObject({ _tag: "BudgetExhausted", remainingMicros: 50_000 });
      expect(await run(ledger())).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("RunStore rows", () => {
  test("a stored Run decodes with every photo verdict, and its identity comes from the report", async () => {
    const { runtime, run } = await storeWithRun(1);
    try {
      const stored = await run(withStore((store) => store.loadRun("run")));
      expect(stored.photoReport).toEqual(photoReport);
      expect(stored.identity).toEqual({
        faceModel: "fake",
        gate: 0.4,
        anchor: [1, 0],
        ceiling: { value: 0.7, source: "median-pairwise" },
      });
      expect(stored.budgetMicros).toBe(toMicros(1));
      const missing = await run(Effect.flip(withStore((store) => store.loadRun("nope"))));
      expect(missing).toMatchObject({ notFound: true });
    } finally {
      await runtime.dispose();
    }
  });

  test("a stored report without an Identity Anchor (written outside the store) fails to load", async () => {
    const { runtime, databasePath } = await storeWithRun(1);
    await runtime.dispose();
    const { identity: _, ...withoutIdentity } = photoReport;
    tamper(
      databasePath,
      "UPDATE runs SET photo_report = ? WHERE id = 'run'",
      JSON.stringify(withoutIdentity),
    );
    const reopened = ManagedRuntime.make(LibsqlRunStore(databasePath) as Layer.Layer<RunStore>);
    try {
      const error = await reopened.runPromise(Effect.flip(withStore((s) => s.loadRun("run"))));
      expect(error.message).toContain("no Identity Anchor");
      expect(error).not.toMatchObject({ notFound: true });
    } finally {
      await reopened.dispose();
    }
  });

  test("a settled call can't be settled again: its recorded cost stays", async () => {
    const { runtime, run } = await storeWithRun(1);
    try {
      await run(reserve(0, 100_000));
      await run(settle(0, 30_000));
      const error = await run(Effect.flip(settle(0, null)));
      expect(error.message).toContain("already settled");
      const [call] = await run(ledger());
      expect(call).toMatchObject({ settled: true, actualMicros: 30_000 });
    } finally {
      await runtime.dispose();
    }
  });

  test("updates of a row that doesn't exist fail instead of changing nothing", async () => {
    const { runtime, run } = await storeWithRun(1);
    try {
      for (const effect of [
        settle(9, 0),
        withStore((s) => s.stopLane("run", 7, "iteration-limit")),
        withStore((s) => s.setCandidateOutcome(key(9), { _tag: "Failed", reason: "x" })),
      ]) {
        const error = await run(Effect.flip(effect));
        expect(error.message).toContain("no such row");
      }
    } finally {
      await runtime.dispose();
    }
  });

  test("the candidates table rejects rows with neither outcome nor image, or half an image", async () => {
    const { runtime, databasePath } = await storeWithRun(1);
    await runtime.dispose();
    const insert = (
      candidate: number,
      outcome: string | null,
      sha: string | null,
      type: string | null,
    ) =>
      tamper(
        databasePath,
        `INSERT INTO candidates (run_id, lane, iteration, candidate, outcome, image_sha256, image_type)
         VALUES ('run', 0, 1, ?, ?, ?, ?)`,
        candidate,
        outcome,
        sha,
        type,
      );
    expect(() => insert(0, null, null, null)).toThrow(/CHECK/);
    expect(() => insert(1, null, "abc", null)).toThrow(/CHECK/);
    expect(() => insert(2, '{"_tag":"Failed","reason":"x"}', null, "image/jpeg")).toThrow(/CHECK/);
    insert(3, null, "abc", "image/jpeg");
  });

  test("a judgement whose scores don't follow from its levels is never stored, and a tampered one names its Candidate", async () => {
    const { runtime, run, databasePath } = await storeWithRun(1);
    try {
      const judged = scoreVerdict(
        { levels: byCriterion(JUDGED_CRITERIA, () => 4), issues: [], promptFixes: [] },
        7,
        DEFAULT_WEIGHTS,
        RUBRIC_V1,
      );
      const bad = { ...judged, scores: { ...judged.scores, realism: 10 } };
      const error = await run(Effect.flip(withStore((store) => store.saveJudgement(key(0), bad))));
      expect(error.message).toContain("Saving the judgement of Candidate 0 failed");
      expect(error.message).toContain("don't follow from the levels");

      tamper(
        databasePath,
        `INSERT INTO candidates (run_id, lane, iteration, candidate, outcome, image_sha256, image_type)
         VALUES ('run', 0, 1, 2, '{"_tag":"Failed","reason":"x"}', NULL, NULL)`,
      );
      tamper(
        databasePath,
        "INSERT INTO judgements (run_id, lane, iteration, candidate, judgement) VALUES ('run', 0, 1, 2, ?)",
        JSON.stringify(bad),
      );
      const unreadable = await run(Effect.flip(withStore((store) => store.loadRecords("run"))));
      expect(unreadable.message).toContain("the judgement of Lane 0, Iteration 1, Candidate 2");
    } finally {
      await runtime.dispose();
    }
  });

  test("a database from before the Judge is refused, for writing and for reading", async () => {
    const databasePath = join(await temporaryDirectory(), "old.db");
    tamper(
      databasePath,
      `CREATE TABLE cost_records (run_id TEXT, lane INTEGER, iteration INTEGER, candidate INTEGER,
         attempt INTEGER, PRIMARY KEY (run_id, lane, iteration, candidate, attempt))`,
    );
    for (const readOnly of [false, true]) {
      const runtime = ManagedRuntime.make(LibsqlRunStore(databasePath, { readOnly }));
      try {
        await expect(runtime.runPromise(withStore((store) => store.loadRun("x")))).rejects.toThrow(
          "predate the Judge",
        );
      } finally {
        await runtime.dispose();
      }
    }
  });

  test("reading needs an existing database file and doesn't create one", async () => {
    const directory = await temporaryDirectory();
    const missing = join(directory, "missing.db");
    const runtime = ManagedRuntime.make(LibsqlRunStore(missing, { readOnly: true }));
    try {
      // The store can't start, so the first use of the runtime fails.
      await expect(runtime.runPromise(withStore((store) => store.loadRun("x")))).rejects.toThrow(
        "no such database file",
      );
      expect(await Bun.file(missing).exists()).toBe(false);
    } finally {
      await runtime.dispose();
    }
    // A directory is not "missing": its own error says so.
    const folder = join(directory, "folder.db");
    await mkdir(folder);
    const onFolder = ManagedRuntime.make(LibsqlRunStore(folder, { readOnly: true }));
    try {
      await expect(onFolder.runPromise(withStore((store) => store.loadRun("x")))).rejects.toThrow(
        "not a database file",
      );
    } finally {
      await onFolder.dispose();
    }
    // Any other stat error passes through as itself, not as "missing".
    if (process.getuid?.() === 0) return; // root reads through any permission
    const locked = join(directory, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    const behindLock = ManagedRuntime.make(
      LibsqlRunStore(join(locked, "runs.db"), { readOnly: true }),
    );
    try {
      const error = await behindLock
        .runPromise(withStore((store) => store.loadRun("x")))
        .catch((failure: unknown) => String(failure));
      expect(error).toMatch(/EACCES|permission denied/i);
      expect(error).not.toContain("no such database file");
    } finally {
      await chmod(locked, 0o700);
      await behindLock.dispose();
    }
  });
});
