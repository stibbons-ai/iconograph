import { parseDocument } from "yaml";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const adrDirectory = "docs/adr/";
const filenamePattern = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$(?![\s\S])/;
const statuses: Record<string, true> = {
  proposed: true,
  accepted: true,
  deprecated: true,
  superseded: true,
};
const keys: Record<string, true> = {
  title: true,
  status: true,
  date: true,
  supersedes: true,
  amends: true,
};

function isAdr(path: string): boolean {
  return (
    path.startsWith(adrDirectory) && /\.md$/i.test(path) && path !== `${adrDirectory}README.md`
  );
}

function validFilename(path: string): boolean {
  return filenamePattern.test(path.slice(adrDirectory.length));
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function firstHeading(body: string): string | undefined {
  let title: string | undefined;
  Bun.markdown.render(body, {
    heading: (text, { level }) => {
      if (level === 1 && title === undefined) title = text.trim();
      return "";
    },
    html: () => "",
  });
  return title;
}

/** Validate one snapshot document against the basenames present in the same snapshot. */
export function validateAdr(
  path: string,
  source: string,
  inventory: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${path}: ${message}`);
  if (!validFilename(path)) fail("expected a root-level NNNN-lowercase-slug.md ADR filename");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    fail("missing YAML frontmatter (start the file with ---)");
    return errors;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    fail("missing closing --- frontmatter delimiter");
    return errors;
  }
  let parsed: unknown;
  try {
    const document = parseDocument(lines.slice(1, end).join("\n"), {
      uniqueKeys: true,
      stringKeys: true,
    });
    const problems = [...document.errors, ...document.warnings];
    if (problems.length) throw new Error(problems.map((error) => error.message).join("; "));
    parsed = document.toJS();
  } catch (error) {
    fail(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("frontmatter must be a YAML mapping");
    return errors;
  }
  const metadata = parsed as Record<string, unknown>;
  for (const key of Object.keys(metadata)) {
    if (!Object.hasOwn(keys, key)) fail(`unknown frontmatter key ${JSON.stringify(key)}`);
  }
  if (
    typeof metadata.title !== "string" ||
    !metadata.title.trim() ||
    /[\r\n\u2028\u2029]/.test(metadata.title)
  ) {
    fail("title must be a nonempty single-line string");
  } else if (metadata.title !== firstHeading(lines.slice(end + 1).join("\n"))) {
    fail("title must match the first body H1 heading");
  }
  if (typeof metadata.status !== "string" || !Object.hasOwn(statuses, metadata.status)) {
    fail("status must be proposed, accepted, deprecated, or superseded");
  }
  if (!validDate(metadata.date)) fail("date must be a real YYYY-MM-DD calendar date");
  const relationships = new Map<string, Set<string>>();
  for (const key of ["supersedes", "amends"]) {
    if (!Object.hasOwn(metadata, key)) continue;
    const value = metadata[key];
    if (!Array.isArray(value)) {
      fail(`${key} must be an array of existing ADR basenames`);
      continue;
    }
    const seen = new Set<string>();
    relationships.set(key, seen);
    for (const reference of value) {
      if (typeof reference !== "string" || !filenamePattern.test(reference)) {
        fail(`${key} entries must be canonical ADR basenames`);
        continue;
      }
      if (seen.has(reference)) fail(`${key} contains duplicate reference ${reference}`);
      seen.add(reference);
      if (reference === basename(path)) fail(`${key} cannot reference this ADR itself`);
      else if (!inventory.has(reference)) fail(`${key} references missing ADR ${reference}`);
    }
  }
  for (const reference of relationships.get("supersedes") ?? []) {
    if (relationships.get("amends")?.has(reference))
      fail(`${reference} cannot appear in both supersedes and amends`);
  }
  return errors;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.toString();
}

async function worktreePaths(cwd: string, directory = "docs/adr"): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(cwd, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await worktreePaths(cwd, path)));
    else if (isAdr(path)) paths.push(path);
  }
  return paths;
}

export async function checkAdrs(
  options: { cwd?: string; staged?: boolean } = {},
): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const staged = options.staged ?? false;
  const paths = staged
    ? git(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--", "docs/adr/"])
        .split("\0")
        .filter(isAdr)
    : await worktreePaths(cwd);
  if (paths.length === 0) return [];
  let inventoryPaths = paths;
  if (staged) {
    // Unlike ls-files, an index diff against the empty tree excludes intent-to-add placeholders.
    const emptyTree = git(cwd, ["hash-object", "-t", "tree", "--stdin"]).trim();
    inventoryPaths = git(cwd, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--ita-invisible-in-index",
      emptyTree,
      "--",
      "docs/adr/",
    ])
      .split("\0")
      .filter(isAdr);
  }
  const inventory = new Set(inventoryPaths.filter(validFilename).map((path) => basename(path)));
  const errors: string[] = [];
  for (const path of paths.sort()) {
    try {
      const source = staged
        ? git(cwd, ["show", `:${path}`])
        : await readFile(join(cwd, path), "utf8");
      errors.push(...validateAdr(path, source, inventory));
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--staged")) {
      throw new Error("usage: bun scripts/check-adrs.ts [--staged]");
    }
    const errors = await checkAdrs({ staged: args[0] === "--staged" });
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`ADR check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
