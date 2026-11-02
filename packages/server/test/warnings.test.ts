import { expect, spyOn, test } from "bun:test";
import { Effect, Logger } from "effect";
import { printWarning, type RunWarning, warningLogger } from "../src/warnings";

/** The warnings `effect` logs, through the warning logger. */
async function warningsOf(effect: Effect.Effect<unknown, unknown>) {
  const warnings: RunWarning[] = [];
  await Effect.runPromise(
    effect.pipe(Effect.provide(Logger.layer([warningLogger((warning) => warnings.push(warning))]))),
  );
  return warnings;
}

test("a warning carries its level, joined message and log annotations, and no cause when there is none", async () => {
  const warnings = await warningsOf(
    Effect.logWarning("Settling", "call", 0, "failed").pipe(
      Effect.annotateLogs({ runId: "r", candidate: 1 }),
    ),
  );
  expect(warnings).toEqual([
    { level: "Warn", warning: "Settling call 0 failed", runId: "r", candidate: 1 },
  ]);
});

test("a cause is its chain of error messages, without stacks or repeats", async () => {
  const failing = (error: Error) =>
    Effect.fail(error).pipe(Effect.ignore({ log: "Warn", message: "Settling failed" }));
  const [chained] = await warningsOf(
    failing(new Error("Recording call 0 failed", { cause: new Error("SQLITE_BUSY: locked") })),
  );
  expect(chained).toEqual({
    level: "Warn",
    warning: "Settling failed",
    cause: "Recording call 0 failed: SQLITE_BUSY: locked",
  });
  // An error quoting its cause doesn't repeat it.
  const [quoting] = await warningsOf(
    failing(new Error("Recording failed: locked", { cause: new Error("locked") })),
  );
  expect(quoting?.cause).toBe("Recording failed: locked");
});

test("the default destination is stderr, never stdout", () => {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    printWarning({ level: "Warn", warning: "w" });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('{"level":"Warn","warning":"w"}\n');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
