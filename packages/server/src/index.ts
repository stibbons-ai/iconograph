import { createLocalStore } from "@iconograph/adapters";
import type { RunInput } from "@iconograph/domain";
import { Mastra } from "@mastra/core/mastra";
import { Layer, ManagedRuntime } from "effect";
import { createRunWorkflow, RUN_WORKFLOW_ID } from "./workflow";

export { createRunWorkflow, RUN_WORKFLOW_ID, traceMessage } from "./workflow";

export async function createRunApplication(databasePath: string) {
  const storage = createLocalStore(databasePath);
  const runtime = ManagedRuntime.make(Layer.empty);
  try {
    await storage.init();
    const workflow = createRunWorkflow(runtime);
    const mastra = new Mastra({ storage, workflows: { run: workflow }, logger: false });
    const workflows = await storage.getStore("workflows");
    if (!workflows) throw new Error("LibSQL workflow storage is unavailable");

    return {
      async start(input: unknown) {
        const run = await mastra.getWorkflow("run").createRun();
        // The CLI boundary is unknown; run.start performs the Effect-backed validation.
        const result = await run.start({ inputData: input as RunInput });
        if (result.status !== "success") {
          throw new Error(`Run ${run.runId} ${result.status}: ${JSON.stringify(result)}`);
        }
        return {
          runId: run.runId,
          workflowId: RUN_WORKFLOW_ID,
          status: result.status,
          result: result.result,
        };
      },
      async read(runId: string) {
        const snapshot = await workflows.loadWorkflowSnapshot({
          workflowName: RUN_WORKFLOW_ID,
          runId,
        });
        if (!snapshot) throw new Error(`Run not found: ${runId}`);
        return { runId, workflowId: RUN_WORKFLOW_ID, snapshot };
      },
      async close() {
        try {
          await mastra.shutdown();
        } finally {
          try {
            await runtime.dispose();
          } finally {
            await storage.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      await runtime.dispose();
    } finally {
      await storage.close();
    }
    throw error;
  }
}
