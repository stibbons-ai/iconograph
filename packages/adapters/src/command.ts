import { errorLine } from "./errors";

export interface RunMainOptions {
  /** The stderr text for a failure; one JSON line (`errorLine`) by default. */
  formatError?: ((error: unknown) => string) | undefined;
  stderr?: ((text: string) => void) | undefined;
}

/** Run a command's `main(args)`: a failure prints `formatError(error)` to stderr. Returns the exit code. */
export async function runMain(
  main: (args: string[]) => Promise<unknown>,
  args: string[],
  { formatError = errorLine, stderr = (text) => process.stderr.write(text) }: RunMainOptions = {},
): Promise<0 | 1> {
  try {
    await main(args);
    return 0;
  } catch (error) {
    stderr(formatError(error));
    return 1;
  }
}

/** A command's entry point: `runMain` on the process arguments; a failure sets exit code 1. */
export async function runCommand(
  main: (args: string[]) => Promise<unknown>,
  formatError?: (error: unknown) => string,
): Promise<void> {
  if ((await runMain(main, process.argv.slice(2), { formatError })) !== 0) process.exitCode = 1;
}
