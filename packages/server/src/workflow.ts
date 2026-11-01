import { toMastraSchema } from "@iconograph/adapters";
import { RunInput, RunOutput } from "@iconograph/domain";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, type ManagedRuntime, Schema } from "effect";

export const RUN_WORKFLOW_ID = "run";
const inputSchema = toMastraSchema(RunInput);
const outputSchema = toMastraSchema(RunOutput);
const decodeOutput = Schema.decodeUnknownEffect(RunOutput);

export function traceMessage(input: RunInput): RunOutput {
  return { message: input.message, length: input.message.length };
}

export function createRunWorkflow(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  trace: (input: RunInput) => unknown = traceMessage,
) {
  const step = createStep({
    id: "trace-message",
    inputSchema,
    outputSchema,
    execute: ({ inputData }) =>
      runtime.runPromise(
        // Mastra does not validate step output. Keep this decode inside the step.
        Effect.flatMap(
          Effect.sync(() => trace(inputData)),
          decodeOutput,
        ),
      ),
  });

  return createWorkflow({
    id: RUN_WORKFLOW_ID,
    inputSchema,
    outputSchema,
    options: { validateInputs: true, shouldPersistSnapshot: () => true },
  })
    .then(step)
    .commit();
}
