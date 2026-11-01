import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function invoke(...args: string[]) {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", cli, ...args], {
    env: { ...Bun.env, MASTRA_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// End-to-end walkthrough: start through Bun, exit, reopen the same LibSQL file
// in another Bun process, then read Mastra's stored snapshot (not cached output).
test("CLI persists a real Run and reads its snapshot after process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iconograph-cli-"));
  const db = join(directory, "runs.db");
  try {
    const started = await invoke("run", "--db", db, "--input", '{"message":"hello"}');
    expect(started.stderr).toBe("");
    expect(started.exitCode).toBe(0);
    const run = JSON.parse(started.stdout);
    expect(run).toMatchObject({
      workflowId: "run",
      status: "success",
      result: { message: "hello", length: 5 },
    });
    expect(run.runId).toBeString();
    expect((await stat(db)).size).toBeGreaterThan(0);

    const read = await invoke("read", "--db", db, "--run-id", run.runId);
    expect(read.stderr).toBe("");
    expect(read.exitCode).toBe(0);
    const persisted = JSON.parse(read.stdout);
    expect(persisted).toMatchObject({
      runId: run.runId,
      workflowId: "run",
      snapshot: {
        status: "success",
        result: { message: "hello", length: 5 },
        context: {
          input: { message: "hello" },
          "trace-message": { status: "success", output: { message: "hello", length: 5 } },
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("CLI help documents the local database and JSON input", async () => {
  const result = await invoke("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--db PATH");
  expect(result.stdout).toContain("--input JSON");
  expect(result.stdout).toContain("read");
});

test("CLI rejects malformed JSON, invalid schemas, missing runs and unknown arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "iconograph-cli-errors-"));
  const db = join(directory, "runs.db");
  try {
    for (const args of [
      ["--input", "{"],
      ["--input", '{"message":42}', "--db", db],
      ["read", "--db", db, "--run-id", "missing"],
      ["--unknown"],
      [],
    ]) {
      const result = await invoke(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toBeString();
      if (args[1] === '{"message":42}') {
        expect(JSON.parse(result.stderr).error).toContain("message");
        expect(JSON.parse(result.stderr).error).toContain("string");
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
