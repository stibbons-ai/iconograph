import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fixture } from "./face-models";

test("the face fixtures and the README's provenance table list exactly the same files", async () => {
  const directory = dirname(fixture("README.md"));
  const entries = await readdir(directory, { withFileTypes: true });
  // Dotfiles (e.g. a Finder .DS_Store) are ignored; anything else must be a listed file.
  const visible = entries.filter(({ name }) => !name.startsWith("."));
  expect(visible.filter((entry) => !entry.isFile()).map(({ name }) => name)).toEqual([]);
  const files = visible.map(({ name }) => name).filter((name) => name !== "README.md");

  const readme = await readFile(fixture("README.md"), "utf8");
  // Table rows whose first cell is a file name in backticks.
  const rows = readme
    .split("\n")
    .filter((line) => /^\|\s*`[^`]+`\s*\|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const listed = rows.map(([file]) => file!.replaceAll("`", ""));

  expect([...listed].sort()).toEqual([...files].sort());
  // Every provenance column (shows, source, author, licence, modifications) is filled in.
  for (const row of rows) {
    expect(row).toHaveLength(6);
    for (const cell of row) expect(cell.length).toBeGreaterThan(0);
  }
});
