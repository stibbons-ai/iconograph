import { errorMessage, toMastraSchema } from "@iconograph/adapters";
import { RunRequest, TargetLook } from "@iconograph/domain";
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

const facets: readonly string[] = Object.keys(TargetLook.fields);

/**
 * The Run request as the API takes it: `RunRequest`, except that a Target Look
 * key that is no facet fails instead of being dropped. `retouching` is the one
 * facet a request may leave out (it is then `NO_RETOUCHING`), so a misspelled
 * `retouching` must not pass as a missing one. Stored Runs keep decoding with
 * `RunRequest`.
 */
export const RunRequestInput = RunRequest.mapFields(
  (fields) => ({
    ...fields,
    targetLook: Schema.StructWithRest(TargetLook, [
      Schema.Record(
        Schema.String.check(Schema.makeFilter((key: string) => !facets.includes(key))),
        Schema.Unknown.check(Schema.makeFilter(() => "Unknown Target Look facet")),
      ),
    ]),
  }),
  // The request's own check reads only `photos` and `lanes`, which this leaves as they are.
  { unsafePreserveChecks: true },
);

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
   * shutdown (its report still shows the Lanes cancelled). Runs still
   * unwinding then are named in a warning and no longer awaited, so a later
   * call doesn't wait for them again.
   */
  async settled(timeoutMs: number) {
    const pending = [...this.#pending];
    if (pending.length === 0) return;
    const { promise: timedOut, resolve } = Promise.withResolvers<"timed out">();
    const timer = setTimeout(() => resolve("timed out"), timeoutMs);
    try {
      const all = Promise.all(pending.map(([, { promise }]) => promise));
      if ((await Promise.race([all, timedOut])) !== "timed out") return;
      const runIds = pending
        .filter(([runId, entry]) => this.#pending.get(runId) === entry)
        .map(([runId]) => runId);
      for (const runId of runIds) this.#pending.delete(runId);
      this.warn({
        level: "Warn",
        warning: `Cancelled Runs ${runIds.join(", ")} were still unwinding after ${timeoutMs / 1000} s; closing without recording their Lanes`,
        runIds,
      });
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
      inputSchema: toMastraSchema(RunRequestInput),
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
