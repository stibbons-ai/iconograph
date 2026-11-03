import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInsideDataDirectory } from "../src/data-directory";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("data-directory");

/** A data volume with `photos/me.jpg`, and a file outside it. */
async function volume() {
  const root = await temporaryDirectory();
  const data = join(root, "data");
  const outside = join(root, "outside");
  await mkdir(join(data, "photos"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(data, "photos", "me.jpg"), "inside");
  await writeFile(join(outside, "secret.jpg"), "outside");
  return { data, outside };
}

describe("resolveInsideDataDirectory", () => {
  test("returns the real path of a file inside the volume, relative or absolute", async () => {
    const { data } = await volume();
    const real = await realpath(join(data, "photos", "me.jpg"));
    expect(await resolveInsideDataDirectory("photos/me.jpg", data)).toBe(real);
    expect(await resolveInsideDataDirectory(join(data, "photos/me.jpg"), data)).toBe(real);
  });

  test("rejects any `..` segment, even one that stays inside", async () => {
    const { data } = await volume();
    for (const path of ["photos/../photos/me.jpg", "../outside/secret.jpg", "photos\\..\\me.jpg"]) {
      await expect(resolveInsideDataDirectory(path, data)).rejects.toThrow(
        `${path} is not a file inside the data volume`,
      );
    }
  });

  test("rejects an outside path without telling whether it exists", async () => {
    const { data, outside } = await volume();
    for (const path of [join(outside, "secret.jpg"), "/etc/nope-iconograph"]) {
      await expect(resolveInsideDataDirectory(path, data)).rejects.toThrow(
        `${path} is not a file inside the data volume`,
      );
    }
  });

  // Root reads through any permission, so the unreadable directory can't be staged.
  test.skipIf(process.getuid?.() === 0)(
    "rejects an outside path before touching the file system",
    async () => {
      const { data, outside } = await volume();
      const locked = join(outside, "locked");
      await mkdir(locked, { mode: 0o000 });
      try {
        // Resolving it would fail with EACCES; the lexical check answers first.
        await expect(resolveInsideDataDirectory(join(locked, "x.jpg"), data)).rejects.toThrow(
          `${join(locked, "x.jpg")} is not a file inside the data volume`,
        );
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  test("follows symlinks: escaping files and directories are rejected, inside ones accepted", async () => {
    const { data, outside } = await volume();
    await symlink(join(outside, "secret.jpg"), join(data, "photos", "leak.jpg"));
    await symlink(outside, join(data, "photos", "out"));
    await symlink(join(data, "photos", "me.jpg"), join(data, "alias.jpg"));
    await symlink("loop-b.jpg", join(data, "photos", "loop-a.jpg"));
    await symlink("loop-a.jpg", join(data, "photos", "loop-b.jpg"));
    // Through the escaping directory, a missing file reads the same as an existing one, also
    // when used as a directory (ENOTDIR vs ENOENT); a symlink loop (ELOOP) reads the same too.
    for (const path of [
      "photos/leak.jpg",
      "photos/out/secret.jpg",
      "photos/out/absent.jpg",
      "photos/out/secret.jpg/x",
      "photos/out/absent.jpg/x",
      "photos/loop-a.jpg",
    ]) {
      const error = await resolveInsideDataDirectory(path, data).catch((caught: Error) => caught);
      expect(error).toEqual(new Error(`${path} is not a file inside the data volume`));
    }
    expect(await resolveInsideDataDirectory("alias.jpg", data)).toBe(
      await realpath(join(data, "photos", "me.jpg")),
    );
  });

  test("rejects missing files like outside ones, and names directories", async () => {
    const { data } = await volume();
    await expect(resolveInsideDataDirectory("photos/absent.jpg", data)).rejects.toThrow(
      "photos/absent.jpg is not a file inside the data volume",
    );
    await expect(resolveInsideDataDirectory("photos", data)).rejects.toThrow(
      "photos is not a file",
    );
  });

  // Root reads through any permission, so the unreadable directory can't be staged.
  test.skipIf(process.getuid?.() === 0)(
    "an unreadable directory inside reads like a missing file, without absolute paths",
    async () => {
      const { data } = await volume();
      const locked = join(data, "locked");
      await mkdir(locked, { mode: 0o000 });
      try {
        const error = await resolveInsideDataDirectory("locked/x.jpg", data).catch(
          (caught: Error) => caught,
        );
        expect(error).toEqual(new Error("locked/x.jpg is not a file inside the data volume"));
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );
});
