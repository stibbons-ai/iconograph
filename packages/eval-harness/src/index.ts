import type { RunOutput } from "@iconograph/domain";
import { createRunApplication, RUN_WORKFLOW_ID } from "@iconograph/server";

const cases = [
  { name: "ordinary message", message: "hello", length: 5 },
  { name: "empty message", message: "", length: 0 },
  { name: "whitespace preserved", message: " a\n", length: 3 },
  { name: "UTF-16 code units", message: "A😀", length: 3 },
] as const;

function matches(actual: unknown, expected: RunOutput) {
  if (typeof actual !== "object" || actual === null) return false;
  return (
    "message" in actual &&
    actual.message === expected.message &&
    "length" in actual &&
    actual.length === expected.length
  );
}

/** Evaluate only the executable local tracer, including its persisted result. */
export async function evaluateTracer(databasePath: string) {
  const application = await createRunApplication(databasePath);
  try {
    const results = [];
    for (const fixture of cases) {
      const input = { message: fixture.message };
      const expected = { message: fixture.message, length: fixture.length };
      const run = await application.start(input);
      const stored = await application.read(run.runId);
      const checks = {
        output: matches(run.result, expected),
        persisted:
          stored.snapshot.status === "success" && matches(stored.snapshot.result, expected),
      };
      results.push({
        name: fixture.name,
        runId: run.runId,
        passed: checks.output && checks.persisted,
        checks,
      });
    }
    const passed = results.filter((result) => result.passed).length;
    return {
      workflowId: RUN_WORKFLOW_ID,
      total: results.length,
      passed,
      failed: results.length - passed,
      cases: results,
    };
  } finally {
    await application.close();
  }
}
