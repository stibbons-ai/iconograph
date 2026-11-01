import { parseArgs } from "node:util";
import { modelsDirectory, resolveDataDirectory } from "./data-directory";
import { ensureModels, readModelLock, type ModelLock } from "./models";

const help = `Fetch and verify every locked face-model weight file

Usage:
  bun run models:fetch [--data-dir PATH]

Options:
  --data-dir PATH  Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                   Weights are stored in PATH/models.
  --help, -h       Show this help.

Prints JSON listing each model's id, path, sha256 and whether it was downloaded.
Verified files are not downloaded again. A SHA-256 mismatch is an error.
Errors print JSON to stderr and exit nonzero.
`;

/** Test seam: the shipped lock admits only HTTPS, so tests inject one for a local server. */
export interface ModelsCliDependencies {
  lock?: ModelLock;
  stdout?: (text: string) => void;
}

export async function main(args: string[], dependencies: ModelsCliDependencies = {}) {
  const { stdout = (text) => process.stdout.write(text) } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  if (positionals.length > 0) throw new Error("Unexpected arguments; use --help for usage");
  const directory = modelsDirectory(resolveDataDirectory(values["data-dir"]));
  const models = await ensureModels({ lock: dependencies.lock ?? readModelLock(), directory });
  stdout(`${JSON.stringify({ directory, models })}\n`);
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
