import { errorMessage, toMastraSchema } from "@iconograph/adapters";
import { RunRequest } from "@iconograph/domain";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, type ManagedRuntime, Schema } from "effect";
import { laneResult, prepareRun, recordCancelledLanes, runIteration } from "./run-steps";
import type { RunServices } from "./runtime";
import { type EstimateEvent, LaneResult, LaneState, RunResult } from "./schemas";
import type { RunWarning } from "./warnings";

export const RUN_WORKFLOW_ID = "run";
export const LANE_WORKFLOW_ID = "lane";
/** How many Lanes of a Run run at a time; more wait their turn. */
export const LANE_CONCURRENCY = 4;

/** `foreach` needs a mutable array type between steps. */
const Lanes = Schema.mutable(Schema.Array(LaneState));
const LaneResults = Schema.mutable(Schema.Array(LaneResult));

/**
 * Recording cancelled Runs' Lanes, so closing the application can wait for it.
 * Mastra stores a cancel at once but runs `onFinish` only once the Run's steps
 * have unwound; a stop in between would leave the Lanes without a stop reason.
 */
export class CancelRecordings {
  readonly #pending = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  readonly #unwatch = new Map<string, () => void>();

  constructor(private readonly warn: (warning: RunWarning) => void) {}

  /** From now on, a cancel of Run `runId` (an abort of `signal`) is awaited by `settled`. */
  watch(runId: string, signal: AbortSignal | undefined) {
    if (!signal || this.#unwatch.has(runId)) return;
    const onAbort = () => {
      if (!this.#pending.has(runId)) this.#pending.set(runId, Promise.withResolvers());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    this.#unwatch.set(runId, () => signal.removeEventListener("abort", onAbort));
  }

  /** The Run finished: a cancelled one stops its Lanes not yet stopped with `cancelled`. */
  async finished(runId: string, cancelled: boolean, record: () => Promise<void>) {
    this.#unwatch.get(runId)?.();
    this.#unwatch.delete(runId);
    try {
      if (cancelled) {
        await record().catch((error: unknown) =>
          this.warn({
            level: "Warn",
            warning: "Recording the cancelled Lanes failed; the report still shows them cancelled",
            runId,
            cause: errorMessage(error),
          }),
        );
      }
    } finally {
      this.#pending.get(runId)?.resolve();
      this.#pending.delete(runId);
    }
  }

  /**
   * Settles once every cancelled Run seen so far has recorded its Lanes, or
   * after `timeoutMs`: a Run whose steps never unwind mustn't hold up a
   * shutdown (its report still shows the Lanes cancelled).
   */
  async settled(timeoutMs: number) {
    const pending = [...this.#pending.values()].map(({ promise }) => promise);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed out">((resolve) => {
      timer = setTimeout(() => resolve("timed out"), timeoutMs);
    });
    try {
      if ((await Promise.race([Promise.all(pending), timedOut])) === "timed out") {
        this.warn({
          level: "Warn",
          warning: `Cancelled Runs were still unwinding after ${timeoutMs / 1000} s; closing without recording their Lanes`,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The Run workflow (ADR-0001, ADR-0006): prepare → one Lane per Image Model,
 * concurrently → finish. A Lane is a nested workflow that repeats its
 * `iteration` step (`dountil`) until the step gives the Lane a stop reason,
 * then reports its result. The Iteration is one step, not a nested workflow
 * (ADR-0014): Mastra 1.80 runs every pass of a loop over a nested workflow
 * under the enclosing workflow's run id, so cancelling the Run can't abort a
 * second or later pass. Every
 * step body is an Effect program on the shared runtime and decodes its own
 * output, since Mastra doesn't validate step output.
 */
export function createRunWorkflow(
  runtime: ManagedRuntime.ManagedRuntime<RunServices, unknown>,
  cancels: CancelRecordings,
) {
  const run = <A, I>(
    schema: Schema.Codec<A, I>,
    program: Effect.Effect<unknown, unknown, RunServices>,
    signal: AbortSignal | undefined,
  ) =>
    runtime.runPromise(
      program.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        // Mastra keeps only own fields of a thrown error; some Effect errors compute `message`.
        Effect.mapError((error) => new Error(errorMessage(error), { cause: error })),
      ),
      signal ? { signal } : undefined,
    );

  /**
   * One Iteration of a Lane, as a single step. Cancelling the Run aborts the
   * step's signal, which interrupts it and aborts its calls.
   */
  const iteration = createStep({
    id: "iteration",
    description:
      "One Iteration: generate Candidates, score their Likeness, judge them, then stop the Lane or write its next Prompt",
    inputSchema: toMastraSchema(LaneState),
    outputSchema: toMastraSchema(LaneState),
    execute: ({ inputData, abortSignal }) => run(LaneState, runIteration(inputData), abortSignal),
  });

  const prepare = createStep({
    id: "prepare",
    inputSchema: toMastraSchema(RunRequest),
    outputSchema: toMastraSchema(Lanes),
    execute: ({ inputData, runId, writer, abortSignal }) => {
      cancels.watch(runId, abortSignal);
      return run(
        Lanes,
        prepareRun(runId, inputData, (event: EstimateEvent) => writer.write(event)),
        abortSignal,
      );
    },
  });

  const result = createStep({
    id: "result",
    inputSchema: toMastraSchema(LaneState),
    outputSchema: toMastraSchema(LaneResult),
    execute: ({ inputData, abortSignal }) => run(LaneResult, laneResult(inputData), abortSignal),
  });

  const lane = createWorkflow({
    id: LANE_WORKFLOW_ID,
    description: "One Lane: repeat Iterations until a stopping rule fires",
    inputSchema: toMastraSchema(LaneState),
    outputSchema: toMastraSchema(LaneResult),
  })
    .dountil(iteration, async ({ inputData }) => inputData.stopReason !== null)
    .then(result)
    .commit();

  const finish = createStep({
    id: "finish",
    inputSchema: toMastraSchema(LaneResults),
    outputSchema: toMastraSchema(RunResult),
    execute: ({ inputData, runId, abortSignal }) =>
      run(RunResult, Effect.succeed({ runId, lanes: inputData }), abortSignal),
  });

  return (
    createWorkflow({
      id: RUN_WORKFLOW_ID,
      inputSchema: toMastraSchema(RunRequest),
      outputSchema: toMastraSchema(RunResult),
      options: {
        validateInputs: true,
        shouldPersistSnapshot: () => true,
        // A Run that ends cancelled, wherever the cancel landed (in an Iteration, between two,
        // in `prepare` or with Lanes still waiting their turn), stops every Lane not yet stopped
        // with `cancelled`.
        onFinish: ({ status, runId }) =>
          cancels.finished(runId, status === "canceled", () =>
            runtime.runPromise(recordCancelledLanes(runId)),
          ),
      },
    })
      .then(prepare)
      // Mastra types a workflow's `description` and `metadata` as possibly undefined, which a
      // step's optional fields reject under exactOptionalPropertyTypes; runtime is unaffected.
      .foreach(lane as typeof lane & { description: string; metadata: Record<string, never> }, {
        concurrency: LANE_CONCURRENCY,
      })
      .then(finish)
      .commit()
  );
}
