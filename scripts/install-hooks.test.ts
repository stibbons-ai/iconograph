import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const roots: string[] = [];
const repository = join(import.meta.dir, "..");
const adr = "docs/adr/0001-example-decision.md";
const valid = `---
title: Example decision
status: accepted
date: 2026-10-30
---

# Example decision

Keep the decision prose.
`;
const invalid = valid.replace("status: accepted", "status: invalid");
const globalConfig = "[user]\n\tname = Isolated fixture\n\temail = fixture@example.invalid\n";

type Fixture = { cwd: string; env: NodeJS.ProcessEnv; global: string };

function run(fixture: Fixture, command: string[], cwd = fixture.cwd) {
  const result = Bun.spawnSync(command, { cwd, env: fixture.env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(fixture: Fixture, ...args: string[]) {
  return run(fixture, ["git", ...args]);
}

function gitOk(fixture: Fixture, ...args: string[]) {
  const result = git(fixture, ...args);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

function install(fixture: Fixture, cwd = fixture.cwd) {
  return run(fixture, [process.execPath, join(fixture.cwd, "scripts/install-hooks.ts")], cwd);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "iconograph-hooks-"));
  roots.push(root);
  const cwd = join(root, "repo");
  const global = join(root, "global.gitconfig");
  await mkdir(cwd);
  await writeFile(global, globalConfig);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  });
  const result = { cwd, env, global };
  gitOk(result, "init", "--quiet");
  await Promise.all([
    mkdir(join(cwd, "scripts")),
    mkdir(join(cwd, ".githooks")),
    mkdir(join(cwd, "docs/adr"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(repository, ".githooks/pre-commit"), join(cwd, ".githooks/pre-commit")),
    copyFile(join(repository, "scripts/check-adrs.ts"), join(cwd, "scripts/check-adrs.ts")),
    copyFile(join(repository, "scripts/install-hooks.ts"), join(cwd, "scripts/install-hooks.ts")),
    symlink(join(repository, "node_modules"), join(cwd, "node_modules")),
  ]);
  await chmod(join(cwd, ".githooks/pre-commit"), 0o755);
  return result;
}

async function installedFixture() {
  const result = await fixture();
  expect(install(result).exitCode).toBe(0);
  return result;
}

async function committedFixture() {
  const result = await installedFixture();
  await writeFile(join(result.cwd, adr), valid);
  gitOk(result, "add", adr);
  gitOk(result, "commit", "--quiet", "-m", "Initial valid ADR");
  return result;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("safe repository-local hook installation", () => {
  test("installs from a subdirectory, is idempotent, and leaves global configuration untouched", async () => {
    const repo = await fixture();
    expect(install(repo, join(repo.cwd, "docs/adr")).exitCode).toBe(0);
    expect(install(repo).exitCode).toBe(0);
    expect(gitOk(repo, "config", "--local", "--get-all", "core.hooksPath")).toBe(".githooks");
    expect(await readFile(repo.global, "utf8")).toBe(globalConfig);
  });

  test.each(["custom-hooks", ""])("preserves conflicting local hooksPath %j", async (path) => {
    const repo = await fixture();
    gitOk(repo, "config", "--local", "core.hooksPath", path);
    const result = install(repo);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("core.hooksPath");
    expect(gitOk(repo, "config", "--local", "--get", "core.hooksPath")).toBe(path);
    expect(await readFile(repo.global, "utf8")).toBe(globalConfig);
  });

  test("does not hide a conflicting inherited hooksPath with a local override", async () => {
    const repo = await fixture();
    gitOk(repo, "config", "--global", "core.hooksPath", "global-hooks");
    const before = await readFile(repo.global, "utf8");
    expect(install(repo).exitCode).not.toBe(0);
    expect(git(repo, "config", "--local", "--get", "core.hooksPath").exitCode).toBe(1);
    expect(await readFile(repo.global, "utf8")).toBe(before);
  });

  test("can pin an already matching inherited path locally without changing global configuration", async () => {
    const repo = await fixture();
    gitOk(repo, "config", "--global", "core.hooksPath", ".githooks");
    const before = await readFile(repo.global, "utf8");
    expect(install(repo).exitCode).toBe(0);
    expect(gitOk(repo, "config", "--local", "--get", "core.hooksPath")).toBe(".githooks");
    expect(await readFile(repo.global, "utf8")).toBe(before);
  });

  test.each(["pre-commit", "pre-push", "commit-msg"])(
    "preserves an active default %s hook",
    async (name) => {
      const repo = await fixture();
      const hook = join(repo.cwd, ".git/hooks", name);
      const source = "#!/bin/sh\nexit 23\n";
      await writeFile(hook, source, { mode: 0o755 });
      const result = install(repo);
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(hook, "utf8")).toBe(source);
      expect(git(repo, "config", "--local", "--get", "core.hooksPath").exitCode).toBe(1);
    },
  );

  test("preserves an executable default hook reached through a symlink", async () => {
    const repo = await fixture();
    const target = join(repo.cwd, "shared-pre-push");
    const hook = join(repo.cwd, ".git/hooks/pre-push");
    const source = "#!/bin/sh\nexit 23\n";
    await writeFile(target, source, { mode: 0o755 });
    await symlink(target, hook);
    expect(install(repo).exitCode).not.toBe(0);
    expect(await readFile(hook, "utf8")).toBe(source);
    expect(git(repo, "config", "--local", "--get", "core.hooksPath").exitCode).toBe(1);
  });

  test("installs when the default hooks directory is absent", async () => {
    const repo = await fixture();
    await rm(join(repo.cwd, ".git/hooks"), { recursive: true });
    expect(install(repo).exitCode).toBe(0);
    expect(gitOk(repo, "config", "--local", "--get", "core.hooksPath")).toBe(".githooks");
  });

  test("allows inactive default hooks and hook samples without rewriting them", async () => {
    const repo = await fixture();
    const hook = join(repo.cwd, ".git/hooks/pre-commit");
    const sample = `${hook}.sample`;
    await writeFile(hook, "inactive default hook\n", { mode: 0o644 });
    await writeFile(sample, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
    await mkdir(join(repo.cwd, ".git/hooks/support"));
    expect(install(repo).exitCode).toBe(0);
    expect(await readFile(hook, "utf8")).toBe("inactive default hook\n");
    expect(await readFile(sample, "utf8")).toBe("#!/bin/sh\nexit 23\n");
  });

  test("refuses to configure a missing or non-executable repository hook", async () => {
    const repo = await fixture();
    const hook = join(repo.cwd, ".githooks/pre-commit");
    await chmod(hook, 0o644);
    expect(install(repo).exitCode).not.toBe(0);
    await rm(hook);
    expect(install(repo).exitCode).not.toBe(0);
    expect(git(repo, "config", "--local", "--get", "core.hooksPath").exitCode).toBe(1);
  });
});

describe("real Git pre-commit invocation", () => {
  test("blocks an invalid initial ADR and allows a corrected initial commit from a subdirectory", async () => {
    const repo = await installedFixture();
    await writeFile(join(repo.cwd, adr), invalid);
    gitOk(repo, "add", adr);
    const rejected = git(repo, "commit", "--quiet", "-m", "Invalid initial ADR");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain(adr);
    expect(git(repo, "rev-parse", "--verify", "HEAD").exitCode).not.toBe(0);
    await writeFile(join(repo.cwd, adr), valid);
    gitOk(repo, "add", adr);
    const accepted = run(
      repo,
      ["git", "commit", "--quiet", "-m", "Valid initial ADR"],
      join(repo.cwd, "docs/adr"),
    );
    expect(accepted.exitCode).toBe(0);
    expect(gitOk(repo, "show", `HEAD:${adr}`)).toBe(valid.trim());
  });

  test("blocks invalid staged bytes even after the worktree is corrected", async () => {
    const repo = await committedFixture();
    const before = gitOk(repo, "rev-parse", "HEAD");
    await writeFile(join(repo.cwd, adr), invalid);
    gitOk(repo, "add", adr);
    await writeFile(join(repo.cwd, adr), valid);
    const result = git(repo, "commit", "--quiet", "-m", "Invalid staged ADR");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(adr);
    expect(gitOk(repo, "rev-parse", "HEAD")).toBe(before);
    expect(gitOk(repo, "show", `:${adr}`)).toBe(invalid.trim());
    expect(await readFile(join(repo.cwd, adr), "utf8")).toBe(valid);
  });

  test("allows valid staged bytes despite invalid unstaged edits", async () => {
    const repo = await committedFixture();
    const staged = `${valid}\nAdditional accepted context.\n`;
    await writeFile(join(repo.cwd, adr), staged);
    gitOk(repo, "add", adr);
    await writeFile(join(repo.cwd, adr), invalid);
    gitOk(repo, "commit", "--quiet", "-m", "Valid staged ADR");
    expect(gitOk(repo, "show", `HEAD:${adr}`)).toBe(staged.trim());
    expect(await readFile(join(repo.cwd, adr), "utf8")).toBe(invalid);
  });

  test("rejects a malformed rename target and allows a canonical rename", async () => {
    const repo = await committedFixture();
    const malformed = "docs/adr/renamed.md";
    const canonical = "docs/adr/0002-renamed-decision.md";
    gitOk(repo, "mv", adr, malformed);
    const result = git(repo, "commit", "--quiet", "-m", "Malformed rename");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(malformed);
    gitOk(repo, "mv", malformed, canonical);
    gitOk(repo, "commit", "--quiet", "-m", "Canonical rename");
    expect(gitOk(repo, "show", `HEAD:${canonical}`)).toBe(valid.trim());
  });

  test("allows README edits, deletion-only changes, and unrelated commits", async () => {
    const repo = await committedFixture();
    await writeFile(join(repo.cwd, "docs/adr/README.md"), "# Template without frontmatter\n");
    gitOk(repo, "add", "docs/adr/README.md");
    gitOk(repo, "commit", "--quiet", "-m", "Update exempt template");
    gitOk(repo, "rm", adr);
    gitOk(repo, "commit", "--quiet", "-m", "Delete ADR");
    await writeFile(join(repo.cwd, adr), invalid);
    await writeFile(join(repo.cwd, "unrelated.txt"), "Unrelated change\n");
    gitOk(repo, "add", "unrelated.txt");
    gitOk(repo, "commit", "--quiet", "-m", "Unrelated change");
    expect(gitOk(repo, "show", "HEAD:unrelated.txt")).toBe("Unrelated change");
  });
});
