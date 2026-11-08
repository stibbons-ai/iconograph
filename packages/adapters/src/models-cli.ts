import { parseArgs } from "node:util";
import { runCommand, runMain } from "./command";
import { modelsDirectory, resolveDataDirectory } from "./data-directory";
import { downloadableModelIds, ensureModels, readModelLock, type ModelLock } from "./models";

const help = `Fetch and verify every downloadable locked face-model weight file

Usage:
  bun run models:fetch [--data-dir PATH]

Options:
  --data-dir PATH  Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                   Weights are stored in PATH/models.
  --help, -h       Show this help.

Prints JSON listing each model's id, path, sha256 and whether it was downloaded.
Verified files are not downloaded again. A SHA-256 mismatch is an error.
FaceNet is never downloaded (we choose not to redistribute it, ADR-0011): build
it with the command in its lock entry (bun run models:export-facenet).
Errors print JSON to stderr and exit nonzero.
`;

/**
 * Test seams: the lock (the shipped one admits only HTTPS, so tests inject one for a local
 * server), the idle period and the output streams.
 */
export interface ModelsCliDependencies {
  lock?: ModelLock;
  /** Test-sized idle period; operators always get the default. */
  idleTimeoutMs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function main(args: string[], dependencies: ModelsCliDependencies = {}) {
  const { stdout = (text) => process.stdout.write(text), idleTimeoutMs } = dependencies;
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
  const lock = dependencies.lock ?? readModelLock();
  const models = await ensureModels({
    lock,
    directory,
    ids: downloadableModelIds(lock),
    ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
  });
  stdout(`${JSON.stringify({ directory, models })}\n`);
}

/**
 * `main` through `runMain` with injectable seams: what `runCommand(main)` does
 * for the script, returning the exit code instead of setting it.
 */
export function run(args: string[], dependencies: ModelsCliDependencies = {}): Promise<0 | 1> {
  return runMain((input) => main(input, dependencies), args, { stderr: dependencies.stderr });
}

if (import.meta.main) await runCommand(main);
