import { expect, test } from "bun:test";
import { chmod, type FileHandle, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type CleanupErrors, errorMessage } from "../src/errors";
import { writeFileAtomically } from "../src/files";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("files");

/** Make the handle's close report failure after really closing, so no descriptor leaks. */
function failClose(file: FileHandle): void {
  const close = file.close.bind(file);
  file.close = async () => {
    await close();
    throw new Error("close failed");
  };
}

const failure = (attempt: Promise<void>) =>
  attempt.then(
    () => {
      throw new Error("expected the write to fail");
    },
    (caught: unknown) => caught as Error & CleanupErrors,
  );

test("a failed temp-file removal is attached to the original error and shown in its message", async () => {
  const directory = await temporaryDirectory();
  const rejected = new Error("verification failed");
  const attempt = writeFileAtomically(join(directory, "out.bin"), (file) => file.writeFile("x"), {
    suffix: ".tmp",
    verify: async () => {
      // A read-only directory makes removing the temp file fail.
      await chmod(directory, 0o555);
      throw rejected;
    },
  });
  try {
    const error = await failure(attempt);
    expect(error).toBe(rejected);
    expect(error.cleanupErrors).toHaveLength(1);
    expect(error.cleanupErrors![0]).toMatchObject({ code: "EACCES" });
    expect(errorMessage(error)).toStartWith("verification failed (cleanup also failed: EACCES");
  } finally {
    await chmod(directory, 0o755);
  }
  // Exactly the one stranded temp file the attached error is about.
  const left = await readdir(directory);
  expect(left).toHaveLength(1);
  expect(left[0]).toEndWith(".tmp");
});

test("a failed close is attached too, and the write's own error still wins", async () => {
  const directory = await temporaryDirectory();
  const rejected = new Error("write failed");
  const error = await failure(
    writeFileAtomically(
      join(directory, "out.bin"),
      async (file) => {
        failClose(file);
        throw rejected;
      },
      { suffix: ".tmp" },
    ),
  );
  expect(error).toBe(rejected);
  expect(error.cleanupErrors?.map((cleanup) => (cleanup as Error).message)).toEqual([
    "close failed",
  ]);
  expect(await readdir(directory)).toEqual([]);
});

test("a frozen error is rethrown unchanged instead of failing to take cleanup errors", async () => {
  const directory = await temporaryDirectory();
  const frozen = Object.freeze(new Error("frozen"));
  const error = await failure(
    writeFileAtomically(
      join(directory, "out.bin"),
      async (file) => {
        failClose(file);
        throw frozen;
      },
      { suffix: ".tmp" },
    ),
  );
  expect(error).toBe(frozen);
});
