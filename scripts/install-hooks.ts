import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

function git(cwd: string, args: string[], allowMissing = false): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !(allowMissing && result.exitCode === 1)) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().replace(/\n$/, "");
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return false;
    throw error;
  }
}

export async function installHooks(cwd = process.cwd()): Promise<void> {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const configured = git(root, ["config", "--null", "--get-all", "core.hooksPath"], true);
  const paths = configured ? configured.split("\0").slice(0, -1) : [];
  if (paths.some((path) => path !== ".githooks")) {
    throw new Error(
      "Refusing to replace existing core.hooksPath configuration. Integrate the ADR hook with your existing hooks manually.",
    );
  }

  if (paths.length === 0) {
    const commonDir = resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
    const directory = join(commonDir, "hooks");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".sample") && (await executable(join(directory, name)))) {
        throw new Error(
          `Refusing to bypass the existing executable default hook ${name}. Integrate the ADR hook with your existing hooks manually.`,
        );
      }
    }
  }

  if (!(await executable(join(root, ".githooks", "pre-commit")))) {
    throw new Error("The repository .githooks/pre-commit hook is missing or not executable.");
  }
  git(root, ["config", "--local", "--replace-all", "core.hooksPath", ".githooks"]);
}

if (import.meta.main) {
  try {
    await installHooks();
    console.log("Git hooks installed locally: core.hooksPath=.githooks");
  } catch (error) {
    console.error(`Hook installation failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
