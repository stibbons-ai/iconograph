/**
 * Run a CLI entry as its own Bun process with telemetry off and without any
 * vendor key from the developer's shell (a real CLI must never see one), plus
 * `env`; its stdout, stderr and exit code.
 */
export async function spawnWithoutKeys(
  entry: string,
  args: readonly string[],
  env: Record<string, string> = {},
) {
  const {
    GEMINI_API_KEY: _gemini,
    ANTHROPIC_API_KEY: _anthropic,
    OPENAI_API_KEY: _openai,
    GOOGLE_GENERATIVE_AI_API_KEY: _google,
    GOOGLE_API_KEY: _googleAlias,
    ...inherited
  } = Bun.env;
  const child = Bun.spawn([Bun.which("bun") ?? "bun", entry, ...args], {
    env: { ...inherited, MASTRA_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", ...env },
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
