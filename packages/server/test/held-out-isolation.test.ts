import { expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as adapters from "@iconograph/adapters";

// ADR-0008: the Optimizer loop must never reach the held-out face model, or it
// would drift towards it. The held-out module is its own service, outside the
// adapters index; its subpath resolves from the server, so lint bans it there
// and the server's import graph is checked for it.

const serverSource = fileURLToPath(new URL("../src/", import.meta.url));
const packagesRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const heldOutModules = ["held-out-embedder.ts", "heldout-cli.ts", "calibrate-cli.ts"].map((name) =>
  join(packagesRoot, "adapters", "src", name),
);
/** Source files Bun can import; anything else (e.g. the JSON model lock) imports nothing. */
const loaders: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

/**
 * Every workspace source file reachable by static or dynamic import from
 * `entries`. Only built-ins may stay unresolved; any other specifier that
 * doesn't resolve fails, so the walk can't silently skip a statically named
 * import. Computed `import()` specifiers and `new Worker(new URL(…))` are
 * invisible to `scanImports`.
 */
function workspaceImportGraph(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = entries.map((entry) => realpathSync(entry));
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const transpiler = new Bun.Transpiler({ loader: loaders[extname(file)]! });
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (isBuiltin(path) || path.startsWith("bun:") || path === "bun") continue;
      const resolved = realpathSync(Bun.resolveSync(path, dirname(file)));
      const workspace = resolved.startsWith(packagesRoot) && !resolved.includes("/node_modules/");
      if (workspace && extname(resolved) in loaders) pending.push(resolved);
    }
  }
  return seen;
}

/** Every source file under `directory`, recursively. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => extname(name) in loaders)
    .map((name) => join(directory, name));
}

test("the adapters package exports nothing of the held-out model", () => {
  expect(Object.keys(adapters).filter((name) => /held|facenet/i.test(name))).toEqual([]);
});

test("the held-out module resolves from the server only by its subpath, which lint forbids there", () => {
  for (const name of [
    "src/held-out-embedder",
    "src/held-out-embedder.ts",
    "src/heldout-cli.ts",
    "src/calibrate-cli.ts",
  ]) {
    expect(() => Bun.resolveSync(`@iconograph/adapters/${name}`, serverSource)).toThrow();
  }
  expect(Bun.resolveSync("@iconograph/adapters/held-out", serverSource)).toBe(
    join(packagesRoot, "adapters", "src", "held-out-embedder.ts"),
  );
  // A lint override banning exactly that specifier applies to every server source and test file.
  const config = JSON.parse(readFileSync(join(packagesRoot, "..", ".oxlintrc.json"), "utf8")) as {
    overrides: {
      files: string[];
      rules: { "no-restricted-imports"?: [string, { patterns: { regex: string }[] }] };
    }[];
  };
  const serverRoot = join(packagesRoot, "server");
  const serverFiles = [...sourceFiles(serverSource), ...sourceFiles(join(serverRoot, "test"))].map(
    (file) => join("packages", "server", file.slice(serverRoot.length + 1)),
  );
  expect(serverFiles.length).toBeGreaterThan(10);
  for (const file of serverFiles) {
    const banned = config.overrides
      .filter(({ files }) => files.some((glob) => new Bun.Glob(glob).match(file)))
      .flatMap(({ rules }) => rules["no-restricted-imports"]?.[1].patterns ?? [])
      .some(({ regex }) => new RegExp(regex).test("@iconograph/adapters/held-out"));
    expect({ file, banned }).toEqual({ file, banned: true });
  }
});

test("no server module, including the run workflow, imports the held-out model", () => {
  const graph = workspaceImportGraph(sourceFiles(serverSource));
  // The graph does reach the adapters (e.g. the SFace pipeline via the index)...
  expect(graph).toContain(join(packagesRoot, "adapters", "src", "index.ts"));
  expect(graph).toContain(join(packagesRoot, "adapters", "src", "face-embedder.ts"));
  // ...but never the held-out embedder or its command.
  for (const module of heldOutModules) expect(graph).not.toContain(module);
});
