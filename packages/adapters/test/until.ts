/**
 * Poll `condition` until it holds, for state no event announces (another
 * process's, or the file system mid-download); throws after `timeoutMs`.
 */
export async function until(
  condition: () => Promise<boolean>,
  { timeoutMs = 2_000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Condition not reached within ${timeoutMs} ms`);
    await Bun.sleep(intervalMs);
  }
}
