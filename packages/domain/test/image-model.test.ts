import { expect, test } from "bun:test";
import {
  type CallGate,
  type CallResult,
  generateCandidate,
  type ImageModel,
  notSent,
} from "../src";
import { Deferred, Effect, Fiber } from "effect";

const request = { prompt: "p", references: [], size: "2K" };

/** A model answering from a script, recording when each call started and signalling the first. */
function scripted(results: (CallResult | "hang")[]) {
  const started: number[] = [];
  const firstCall = Deferred.makeUnsafe<void>();
  const model: ImageModel = {
    model: "m",
    capabilities: { maxCharacterReferences: 4, sizes: ["2K"], qualities: [] },
    price: {
      model: "m",
      pricing: { _tag: "Llm", inputPerToken: 0, outputPerToken: 0 },
      source: { _tag: "override", asOf: "2026-11-02T00:00:00.000Z", ageSeconds: 0 },
    },
    estimate: () => ({ micros: 1, usage: {} }),
    call: () =>
      Effect.suspend(() => {
        const result = results[started.length];
        started.push(performance.now());
        Deferred.doneUnsafe(firstCall, Effect.void);
        return result === "hang" ? Effect.never : Effect.succeed(result!);
      }),
  };
  return { model, started, firstCall };
}

/**
 * A gate recording the settles. `settled` completes on the first settle;
 * a retry's reservation signals `reserving`, then waits for `admit`.
 */
function recordingGate() {
  const settles: [number, CallResult][] = [];
  const settled = Deferred.makeUnsafe<void>();
  const reserving = Deferred.makeUnsafe<void>();
  const admit = Deferred.makeUnsafe<void>();
  const gate: CallGate = {
    reserve: () =>
      Deferred.succeed(reserving, undefined).pipe(Effect.andThen(Deferred.await(admit))),
    settle: (attempt, result) =>
      Effect.sync(() => {
        settles.push([attempt, result]);
        Deferred.doneUnsafe(settled, Effect.void);
      }),
  };
  return { gate, settles, settled, reserving, admit };
}

const transient: CallResult = { kind: "transient", reason: "503", costMicros: 0 };

test("each retry waits twice as long as the one before", async () => {
  const { model, started } = scripted([transient, transient, transient]);
  const { gate, admit } = recordingGate();
  Deferred.doneUnsafe(admit, Effect.void);
  // Real time on purpose: the backoff is a real sleep, measured from outside.
  await Effect.runPromise(
    generateCandidate({ model, request, gate, policy: { maxRetries: 2, baseDelayMs: 40 } }),
  );
  expect(started).toHaveLength(3);
  const [first, second, third] = started as [number, number, number];
  expect(second - first).toBeGreaterThanOrEqual(38);
  expect(third - second).toBeGreaterThanOrEqual(78);
});

test("an interrupted call already sent is settled as of unknown cost", async () => {
  const { model, firstCall } = scripted(["hang"]);
  const { gate, settles } = recordingGate();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(generateCandidate({ model, request, gate }));
      yield* Deferred.await(firstCall);
      yield* Fiber.interrupt(fiber);
    }),
  );
  expect(settles).toEqual([
    [0, { kind: "transient", reason: "Interrupted before the call finished", costMicros: null }],
  ]);
});

test("an interrupt while a retry is being reserved books that retry as never sent, at $0", async () => {
  const { model, started } = scripted([transient, "hang"]);
  const { gate, settles, reserving, admit } = recordingGate();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        generateCandidate({ model, request, gate, policy: { maxRetries: 2, baseDelayMs: 0 } }),
      );
      yield* Deferred.await(reserving);
      // The interrupt is requested while the (uninterruptible) reservation is pending.
      fiber.interruptUnsafe();
      yield* Deferred.succeed(admit, undefined);
      yield* Fiber.await(fiber);
    }),
  );
  expect(started).toHaveLength(1);
  expect(settles).toEqual([
    [0, transient],
    [1, notSent("interrupted first")],
  ]);
});

test("an interrupt during the backoff after a settled call settles nothing more", async () => {
  const { model } = scripted([transient]);
  const { gate, settles, settled } = recordingGate();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        generateCandidate({ model, request, gate, policy: { maxRetries: 2, baseDelayMs: 60_000 } }),
      );
      yield* Deferred.await(settled);
      yield* Fiber.interrupt(fiber);
    }),
  );
  expect(settles).toEqual([[0, transient]]);
});
