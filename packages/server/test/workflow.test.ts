import { expect, test } from "bun:test";
import { toMastraSchema } from "@iconograph/adapters";
import { RunInput } from "@iconograph/domain";
import { Mastra } from "@mastra/core/mastra";
import { Layer, ManagedRuntime } from "effect";
import { createRunWorkflow } from "../src";

test("workflow input validation preserves the Effect issue message and path", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  let called = false;
  const workflow = createRunWorkflow(runtime, () => {
    called = true;
    return { message: "unexpected", length: 10 };
  });
  const mastra = new Mastra({ workflows: { run: workflow }, logger: false });
  try {
    const invalid = { message: 42 };
    const expected = await toMastraSchema(RunInput)["~standard"].validate(invalid);
    const run = await mastra.getWorkflow("run").createRun();
    // Deliberately cross the static boundary to exercise Mastra's runtime validation.
    const input = invalid as unknown as RunInput;
    await expect(run.start({ inputData: input })).rejects.toThrow(
      `message: ${expected.issues?.[0]?.message}`,
    );
    expect(called).toBe(false);
  } finally {
    await mastra.shutdown();
    await runtime.dispose();
  }
});

test("the real tracer step rejects invalid output through its explicit Effect decode", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const workflow = createRunWorkflow(runtime, () => ({ message: "hello", length: "wrong" }));
  const mastra = new Mastra({ workflows: { run: workflow }, logger: false });
  try {
    const run = await mastra.getWorkflow("run").createRun();
    const result = await run.start({ inputData: { message: "hello" } });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Invalid output unexpectedly succeeded");
    expect(result.error.message).toContain("length");
    expect(result.steps["trace-message"]?.status).toBe("failed");
  } finally {
    await mastra.shutdown();
    await runtime.dispose();
  }
});
