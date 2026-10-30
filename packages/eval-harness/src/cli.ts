import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { evaluateTracer } from "./index";

export async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { db: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: bun run eval [--db PATH]\nEvaluate the local Run tracer's output and persistence. No model calls.\nWithout --db, an isolated temporary LibSQL file is removed after evaluation.\n",
    );
    return;
  }
  const directory =
    values.db === undefined ? await mkdtemp(join(tmpdir(), "iconograph-eval-")) : undefined;
  try {
    const report = await evaluateTracer(values.db ?? join(directory!, "runs.db"));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
