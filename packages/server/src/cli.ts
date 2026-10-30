import { parseArgs } from "node:util";
import { createRunApplication } from "./index";

const help = `Iconograph local Run tracer (no model calls)

Usage:
  bun run run [run] [--db PATH] --input JSON
  bun run run read [--db PATH] --run-id ID

Options:
  --db PATH       Local LibSQL file (default: ./iconograph.db).
                  Parent directory must already exist.
  --input JSON    Run input, for example '{"message":"hello"}'.
  --run-id ID     Persisted workflow run to read from disk.
  --help, -h      Show this help.

Run prints JSON containing runId, workflowId, status and result.
Read prints JSON containing the persisted Mastra workflow snapshot.
The tracer echoes message and its JavaScript UTF-16 code-unit length.
Errors print JSON to stderr and exit nonzero.
`;

export async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string", default: "./iconograph.db" },
      input: { type: "string" },
      "run-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const command = positionals[0] ?? "run";
  if (positionals.length > 1 || (command !== "run" && command !== "read")) {
    throw new Error("Expected run or read; use --help for usage");
  }
  if (command === "run" && (values.input === undefined || values["run-id"] !== undefined)) {
    throw new Error("run requires --input JSON and does not accept --run-id");
  }
  if (command === "read" && (values["run-id"] === undefined || values.input !== undefined)) {
    throw new Error("read requires --run-id ID and does not accept --input");
  }
  const input: unknown = command === "run" ? JSON.parse(values.input!) : undefined;
  const application = await createRunApplication(values.db);
  try {
    const result =
      command === "run"
        ? await application.start(input)
        : await application.read(values["run-id"]!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await application.close();
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
