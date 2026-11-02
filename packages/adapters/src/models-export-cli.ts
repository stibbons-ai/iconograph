import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { modelsDirectory, resolveDataDirectory } from "./data-directory";
import { errorLine, errorMessage } from "./errors";
import { writeFileAtomically } from "./files";
import { hashFile, type ModelLock, readModelLock } from "./models";

const help = `Build the FaceNet weights locally and verify them against the lock

Usage:
  bun run models:export-facenet [--data-dir PATH]

Options:
  --data-dir PATH  Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                   The ONNX file is written to PATH/models.
  --help, -h       Show this help.

The FaceNet weights are never downloaded (we choose not to redistribute them:
their training data's terms are unsettled, ADR-0011): this runs
scripts/export-facenet.py with uv (https://docs.astral.sh/uv/,
which installs the pinned Python and PyTorch), fetching the upstream PyTorch
weights it verifies by SHA-256. The export is installed only if its SHA-256
matches the lock. An already verified file is kept; a file whose SHA-256 doesn't
match is rebuilt (a JSON warning on stderr names its hash). Prints JSON with the
model's id, path, sha256 and whether it was built; the export's own output goes
to stderr. Errors print JSON to stderr and exit nonzero.
`;

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Runs `command` with its stdout and stderr on this process's stderr; resolves to the exit code. */
export type Runner = (command: string[]) => Promise<number>;

// Async so a spawn failure (e.g. uv not installed) rejects instead of throwing.
const runOnStderr: Runner = async (command) =>
  Bun.spawn(command, { cwd: repositoryRoot, stdin: "ignore", stdout: 2, stderr: 2 }).exited;

/** Test seams: the lock, how the export script is run, and the output streams. */
export interface ModelsExportCliDependencies {
  lock?: ModelLock;
  run?: Runner;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function main(args: string[], dependencies: ModelsExportCliDependencies = {}) {
  const {
    run = runOnStderr,
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
  } = dependencies;
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
  const lock = dependencies.lock ?? readModelLock();
  // The only built entry today; the lock schema allows more, each with its own command.
  const model = lock.models.find((candidate) => candidate.id === "facenet");
  if (!model?.build) throw new Error("The lock has no built facenet entry");
  const directory = modelsDirectory(resolveDataDirectory(values["data-dir"]));
  const path = join(directory, model.file);
  await mkdir(directory, { recursive: true });
  // Rebuild only a missing or mismatching file; a read error (e.g. EACCES) is raised.
  const present = await hashFile(path).catch((error: unknown) => {
    throw new Error(`Model ${model.id} at ${path} could not be read: ${errorMessage(error)}`, {
      cause: error,
    });
  });
  if (present === model.sha256) {
    stdout(`${JSON.stringify({ id: model.id, path, sha256: model.sha256, built: false })}\n`);
    return;
  }
  if (present !== undefined) {
    stderr(
      `${JSON.stringify({ warning: `Rebuilding ${path}: its SHA-256 ${present} does not match the lock's ${model.sha256}` })}\n`,
    );
  }
  // An interrupted earlier build (e.g. Ctrl-C) leaves its ~94 MB temp file behind.
  const suffix = ".partial.onnx";
  for (const name of await readdir(directory)) {
    if (name.startsWith(`${model.file}.`) && name.endsWith(suffix)) {
      await rm(join(directory, name), { force: true });
    }
  }
  await writeFileAtomically(
    path,
    async () => {
      // The script writes the temp file by path; the atomic write verifies and renames it.
    },
    {
      suffix,
      verify: async (temporary) => {
        const command = ["uv", "run", join(repositoryRoot, model.build.script), temporary];
        const code = await run(command).catch((error: unknown) => {
          throw new Error(
            `Could not run ${command[0]} (install uv: https://docs.astral.sh/uv/): ${errorMessage(error)}`,
          );
        });
        if (code !== 0) throw new Error(`${command.join(" ")} exited with code ${code}`);
        // Durable before the rename; a script that removed its output fails here.
        const file = await open(temporary, "r").catch((error: unknown) => {
          throw new Error(`The FaceNet export wrote no file: ${errorMessage(error)}`);
        });
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        const actual = await hashFile(temporary);
        if (actual !== model.sha256) {
          throw new Error(
            `The FaceNet export failed SHA-256 verification: expected ${model.sha256}, actual ${actual}; nothing was installed`,
          );
        }
      },
    },
  );
  stdout(`${JSON.stringify({ id: model.id, path, sha256: model.sha256, built: true })}\n`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(errorLine(error));
    process.exitCode = 1;
  }
}
