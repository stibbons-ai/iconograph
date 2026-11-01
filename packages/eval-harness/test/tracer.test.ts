import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateTracer } from "../src";

test("evaluation checks real tracer output and persisted snapshots for boundary fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iconograph-evaluation-test-"));
  try {
    const report = await evaluateTracer(join(directory, "runs.db"));
    expect(report).toMatchObject({ workflowId: "run", total: 4, passed: 4, failed: 0 });
    expect(report.cases.map((entry) => entry.name)).toEqual([
      "ordinary message",
      "empty message",
      "whitespace preserved",
      "UTF-16 code units",
    ]);
    for (const entry of report.cases) {
      expect(entry.checks).toEqual({ output: true, persisted: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
