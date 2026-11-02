import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Call at the top of a test file whose code runs git: for the file's tests,
 * removes every inherited GIT_* variable (a hook running the tests sets
 * GIT_DIR) and points HOME and XDG_CONFIG_HOME at an empty folder, so neither
 * the developer's global git config (excludes, hooks) nor their environment can
 * change what git reports. Spawned processes inherit the cleaned environment.
 */
export function isolateGitEnvironment() {
  const saved: Record<string, string | undefined> = {};
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "iconograph-git-home-"));
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("GIT_")) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    }
    for (const name of ["HOME", "XDG_CONFIG_HOME"]) {
      saved[name] = process.env[name];
      process.env[name] = home;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
}

/** Run git for test setup in the cleaned environment, without system config; throws on failure. */
export function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A fresh git repository in a directory from `temporaryDirectory`. */
export async function repository(temporaryDirectory: () => Promise<string>) {
  const root = await temporaryDirectory();
  git(root, "init", "--quiet");
  return root;
}

/** Run `action` with `variables` set in this process's environment, then restore it. */
export async function withEnvironment<T>(
  variables: Record<string, string>,
  action: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  Object.assign(process.env, variables);
  try {
    return await action();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
