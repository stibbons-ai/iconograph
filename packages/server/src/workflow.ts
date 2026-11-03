import { errorMessage, toMastraSchema } from "@iconograph/adapters";
import { RunRequest } from "@iconograph/domain";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, type ManagedRuntime, Schema } from "effect";
import { generateIteration, prepareRun, scoreIteration } from "./run-steps";
import type { RunServices } from "./runtime";
import { LaneGenerated, LaneInput, LaneResult, RunResult, type EstimateEvent } from "./schemas";

export const RUN_WORKFLOW_ID = "run";
export const LANE_WORKFLOW_ID = "lane";
/** How many Lanes of a Run run at a time; more wait their turn. */
export const LANE_CONCURRENCY = 4;

/** `foreach` needs a mutable array type between steps. */
const Lanes = Schema.mutable(Schema.Array(LaneInput));
const LaneResults = Schema.mutable(Schema.Array(LaneResult));

/**
 * The Run workflow (ADR-0001, ADR-0006): prepare → one Lane per Image Model,
 * concurrently → finish. A Lane is a nested workflow running one Iteration:
 * generate (parallel calls) → score. Every step body is an Effect program on
 * the shared runtime and decodes its own output, since Mastra doesn't validate
 * step output.
 */
export function createRunWorkflow(runtime: ManagedRuntime.ManagedRuntime<RunServices, unknown>) {
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

  const prepare = createStep({
    id: "prepare",
    inputSchema: toMastraSchema(RunRequest),
    outputSchema: toMastraSchema(Lanes),
    execute: ({ inputData, runId, writer, abortSignal }) =>
      run(
        Lanes,
        prepareRun(runId, inputData, (event: EstimateEvent) => writer.write(event)),
        abortSignal,
      ),
  });

  const generate = createStep({
    id: "generate",
    inputSchema: toMastraSchema(LaneInput),
    outputSchema: toMastraSchema(LaneGenerated),
    execute: ({ inputData, abortSignal }) =>
      run(LaneGenerated, generateIteration(inputData), abortSignal),
  });

  const score = createStep({
    id: "score",
    inputSchema: toMastraSchema(LaneGenerated),
    outputSchema: toMastraSchema(LaneResult),
    execute: ({ inputData, abortSignal }) =>
      run(LaneResult, scoreIteration(inputData), abortSignal),
  });

  const lane = createWorkflow({
    id: LANE_WORKFLOW_ID,
    description: "One Lane: generate an Iteration's Candidates, then score them",
    inputSchema: toMastraSchema(LaneInput),
    outputSchema: toMastraSchema(LaneResult),
  })
    .then(generate)
    .then(score)
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
      options: { validateInputs: true, shouldPersistSnapshot: () => true },
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
