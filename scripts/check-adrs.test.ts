import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdr } from "./check-adrs.ts";

const first = "0001-first.md";
const second = "0002-second.md";
const path = `docs/adr/${first}`;
const inventory = new Set([first, second]);
const document = (
  metadata = "title: First\nstatus: accepted\ndate: 2026-10-30",
  body = "# First\n\nDecision prose.\n",
) => `---\n${metadata}\n---\n\n${body}`;
const valid = document();

function errors(metadata: string, body?: string): string {
  return validateAdr(path, document(metadata, body), inventory).join("\n");
}

const required = "title: First\nstatus: accepted\ndate: 2026-10-30";

describe("ADR frontmatter", () => {
  test.each(["proposed", "accepted", "deprecated", "superseded"])(
    "accepts %s status and optional empty relations",
    (status) => {
      expect(
        errors(`title: First\nstatus: ${status}\ndate: 2026-10-30\nsupersedes: []\namends: []`),
      ).toBe("");
    },
  );

  test("accepts native YAML comments, quoted strings, block lists and CRLF", () => {
    const source = document(
      `title: "First" # comment\nstatus: accepted\ndate: '2024-02-29'\namends:\n  - ${second}`,
    ).replace(/\n/g, "\r\n");
    expect(validateAdr(path, source, inventory)).toEqual([]);
  });

  test.each([
    ["status: accepted\ndate: 2026-10-30", "title"],
    ["title: First\ndate: 2026-10-30", "status"],
    ["title: First\nstatus: accepted", "date"],
    ["title: ''\nstatus: accepted\ndate: 2026-10-30", "title"],
    ["title: 123\nstatus: accepted\ndate: 2026-10-30", "title"],
    ["title: ' '\nstatus: accepted\ndate: 2026-10-30", "title"],
    ["title: |\n  First\nstatus: accepted\ndate: 2026-10-30", "title"],
    ["title: Different\nstatus: accepted\ndate: 2026-10-30", "H1"],
    ["title: First\nstatus: Accepted\ndate: 2026-10-30", "status"],
    [`${required}\nauthor: Nobody`, "unknown"],
    [`${required}\n__proto__: ignored`, "unknown"],
    [`${required}\nconstructor: ignored`, "unknown"],
  ])("rejects invalid fields %s", (metadata, expected) => {
    expect(errors(metadata)).toContain(expected);
  });

  test.each([
    "2025-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-1-01",
    "tomorrow",
    "2026-10-30T00:00:00Z",
    "null",
    "123",
  ])("rejects invalid date %s", (date) => {
    expect(errors(`title: First\nstatus: accepted\ndate: ${date}`)).toContain("date");
  });

  test.each(["2000-02-29", "2024-02-29", "2026-12-31"])("accepts real date %s", (date) => {
    expect(errors(`title: First\nstatus: accepted\ndate: ${date}`)).toBe("");
  });

  test.each([
    `${required}\ntitle: Other`,
    `${required}\n"title": Other`,
    `${required}\n? title\n: Other`,
    `{title: First, title: Other, status: accepted, date: 2026-10-30}`,
    "title: First\n? &statusKey status\n: invalid\n? *statusKey\n: accepted\ndate: 2026-10-30",
    "title: [unterminated",
    "- title: First",
    "null",
    `${required}\n...\ntitle: Other`,
    `title: !unknown First\nstatus: accepted\ndate: 2026-10-30`,
  ])("rejects malformed or ambiguous YAML %s", (metadata) => {
    expect(errors(metadata)).not.toBe("");
  });

  test("requires opening and closing frontmatter delimiters", () => {
    expect(validateAdr(path, "# First", inventory).join()).toContain("missing YAML");
    expect(validateAdr(path, `---\n${required}`, inventory).join()).toContain("closing");
  });

  test("matches the first actual H1 rather than fenced examples or later headings", () => {
    expect(errors(required, "```md\n# Example\n```\n\n# First ###\n")).toBe("");
    expect(errors(required, "First\n=====\n")).toBe("");
    expect(errors(required, "## First\n")).toContain("H1");
    expect(errors(required, "# Other\n\n# First\n")).toContain("H1");
  });
  test("ignores commented headings and rejects bodies with no actual H1", () => {
    expect(errors(required, "<!--\n# Example\n-->\n\n# First\n")).toBe("");
    expect(
      errors(required.replace("title: First", "title: Example"), "<!--\n# Example\n-->\n"),
    ).toContain("H1");
  });

  test("matches plain heading text rather than inline Markdown or HTML entities", () => {
    expect(
      errors(
        required.replace("title: First", "title: First & second"),
        "# **First** &amp; `second`\n",
      ),
    ).toBe("");
  });

  test.each([
    ["amends: null", "array"],
    ["supersedes: 0002-second.md", "array"],
    ["amends: [123]", "basenames"],
    ["amends: [docs/adr/0002-second.md]", "basenames"],
    ["amends: [0003-missing.md]", "missing"],
    [`amends: [${first}]`, "itself"],
    [`amends: [${second}, ${second}]`, "duplicate"],
    [`amends: [${second}]\nsupersedes: [${second}]`, "both"],
  ])("rejects invalid relationships %s", (relations, expected) => {
    expect(errors(`${required}\n${relations}`)).toContain(expected);
  });

  test.each([
    "docs/adr/decision.md",
    "docs/adr/0001-Upper.md",
    "docs/adr/0001-first.MD",
    "docs/adr/nested/0001-first.md",
  ])("rejects malformed filename %s", (file) => {
    expect(validateAdr(file, valid, inventory).join()).toContain(file);
    expect(validateAdr(file, valid, inventory).join()).toContain("filename");
  });
});

const roots: string[] = [];
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_AUTHOR_NAME: "ADR Test",
  GIT_AUTHOR_EMAIL: "adr@example.test",
  GIT_COMMITTER_NAME: "ADR Test",
  GIT_COMMITTER_EMAIL: "adr@example.test",
};
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
])
  delete gitEnv[key];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

async function checkAdrs(options: {
  cwd: string;
  staged?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "check-adrs.ts"),
      ...(options.staged ? ["--staged"] : []),
    ],
    { cwd: options.cwd, env: options.env ?? gitEnv, stdout: "pipe", stderr: "pipe" },
  );
  const diagnostic = result.stderr.toString().trim();
  if (diagnostic.startsWith("ADR check failed:")) throw new Error(diagnostic);
  if (result.exitCode !== 0 && !diagnostic)
    throw new Error(`ADR checker exited ${result.exitCode} without diagnostics`);
  return result.exitCode === 0 ? [] : [diagnostic];
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iconograph-adrs-"));
  roots.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "commit.gpgsign", "false");
  await mkdir(join(root, "docs/adr"), { recursive: true });
  return root;
}

async function put(root: string, file = first, source = valid): Promise<void> {
  const target = join(root, "docs/adr", file);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, source);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ADR snapshot selection", () => {
  test("full checks include untracked and nested malformed Markdown, but exempt only root README", async () => {
    const root = await fixture();
    await put(root);
    await put(root, "README.md", "template without frontmatter");
    expect(await checkAdrs({ cwd: root })).toEqual([]);
    await put(root, "nested/README.md", "invalid");
    await put(root, "bad name\nwith newline.MD", "invalid");
    const failures = await checkAdrs({ cwd: root });
    expect(failures.join()).toContain("nested/README.md");
    expect(failures.join()).toContain("bad name\nwith newline.MD");
    expect(failures.join()).not.toContain("docs/adr/README.md:");
    git(root, "add", ".");
    const stagedFailures = await checkAdrs({ cwd: root, staged: true });
    expect(stagedFailures.join()).toContain("bad name\nwith newline.MD");
    expect(stagedFailures.join()).toContain("nested/README.md");
    expect(stagedFailures.join()).not.toContain("docs/adr/README.md:");
  });

  test("initial repository validates index, not corrected worktree", async () => {
    const root = await fixture();
    await put(root, first, "# Missing frontmatter");
    git(root, "add", "--", path);
    await put(root);
    expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain(`${path}:`);
    expect(await checkAdrs({ cwd: root })).toEqual([]);
  });

  test("valid index passes despite invalid unstaged worktree", async () => {
    const root = await fixture();
    await put(root);
    git(root, "add", ".");
    await put(root, first, "invalid worktree");
    expect(await checkAdrs({ cwd: root, staged: true })).toEqual([]);
    expect((await checkAdrs({ cwd: root })).join()).toContain("frontmatter");
  });

  test("honors the caller's alternate Git index", async () => {
    const root = await fixture();
    await put(root);
    git(root, "add", ".");
    const alternate = join(root, ".git", "alternate-index");
    await copyFile(join(root, ".git", "index"), alternate);
    await put(root, first, "invalid standard index");
    git(root, "add", ".");
    expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain("frontmatter");
    expect(
      await checkAdrs({ cwd: root, staged: true, env: { ...gitEnv, GIT_INDEX_FILE: alternate } }),
    ).toEqual([]);
  });

  test("modified tracked ADR uses staged version", async () => {
    const root = await fixture();
    await put(root);
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");
    await put(root, first, document(required.replace("accepted", "invalid")));
    git(root, "add", ".");
    await put(root);
    expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain("status");
  });

  test("reference inventory is the index, including staged additions and excluding deletions", async () => {
    const root = await fixture();
    await put(root, first, document(`${required}\namends: [${second}]`));
    await put(root, second);
    git(root, "add", "--", path);
    expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain("missing");
    git(root, "add", ".");
    await rm(join(root, "docs/adr", second));
    expect(await checkAdrs({ cwd: root, staged: true })).toEqual([]);
    git(root, "commit", "--quiet", "-m", "initial");
    git(root, "add", "-u");
    await put(root, first, document(`${required}\namends: [${second}]`, "# First\nChanged."));
    git(root, "add", "--", path);
    await put(root, second);
    expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain("missing");
  });

  test.each([false, true])(
    "intent-to-add is absent from the commit inventory (existing HEAD: %s)",
    async (existingHead) => {
      const root = await fixture();
      await put(root);
      await put(root, second);
      if (existingHead) {
        git(root, "add", ".");
        git(root, "commit", "--quiet", "-m", "initial");
        git(root, "rm", "--cached", "--", `docs/adr/${second}`);
      }
      await put(root, first, document(`${required}\namends: [${second}]`));
      git(root, "add", "--", path);
      git(root, "add", "-N", "--", `docs/adr/${second}`);
      expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain("missing");
      git(root, "add", "--", `docs/adr/${second}`);
      expect(await checkAdrs({ cwd: root, staged: true })).toEqual([]);
    },
  );

  test("renames validate destination; deletions, root README and unrelated changes are ignored", async () => {
    const root = await fixture();
    await put(root);
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");
    await rename(join(root, path), join(root, "docs/adr/bad filename.md"));
    git(root, "add", "-A");
    expect((await checkAdrs({ cwd: root, staged: true })).join()).toContain("bad filename.md");
    await rm(join(root, "docs/adr/bad filename.md"));
    await put(root, "README.md", "not an ADR");
    await put(root, "untracked.md", "not staged");
    await writeFile(join(root, "unrelated.txt"), "changed");
    git(root, "add", "--", "docs/adr/bad filename.md", "docs/adr/README.md", "unrelated.txt");
    expect(await checkAdrs({ cwd: root, staged: true })).toEqual([]);
  });

  test("CLI reports file-specific failures and rejects unsupported arguments", async () => {
    const root = await fixture();
    await put(root, first, "invalid");
    for (const args of [[], ["--unknown"]]) {
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "check-adrs.ts"), ...args],
        { cwd: root, env: gitEnv, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(args.length ? "usage:" : `${path}:`);
    }
  });

  test("Git failures remain visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "iconograph-not-git-"));
    roots.push(root);
    await expect(checkAdrs({ cwd: root, staged: true })).rejects.toThrow("git diff failed");
  });
});
