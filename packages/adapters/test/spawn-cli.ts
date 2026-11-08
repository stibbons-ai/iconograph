import { REPOSITORY_ROOT } from "../src/cli-options";

export interface SpawnCliOptions {
  /** Variables set on top of the inherited environment. */
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
}

/**
 * Run `bun <args>` (a CLI entry and its arguments, or `run <script>`) as its own process; its
 * stdout, stderr and exit code. It inherits the current environment, read at
 * the call, so a test's changes to it (e.g. cleaned GIT_*) reach the CLI, but
 * never a vendor key from the developer's shell (a real CLI must never see
 * one); telemetry is off; `env` comes last.
 */
export async function spawnCli(args: readonly string[], { env = {}, cwd }: SpawnCliOptions = {}) {
  const {
    ICONOGRAPH_GEMINI_API_KEY: _gemini,
    ICONOGRAPH_ANTHROPIC_API_KEY: _anthropic,
    ICONOGRAPH_OPENAI_API_KEY: _openai,
    ...inherited
  } = process.env;
  const child = Bun.spawn([process.execPath, ...args], {
    env: { ...inherited, MASTRA_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", ...env },
    ...(cwd !== undefined && { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A root `package.json` script run as an operator would: `bun run --silent <script>` from the repository root. */
export const spawnScript = (script: string, args: readonly string[]) =>
  spawnCli(["run", "--silent", script, ...args], { cwd: REPOSITORY_ROOT });
