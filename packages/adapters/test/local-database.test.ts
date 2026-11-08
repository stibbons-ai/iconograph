import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { openLocalClient } from "../src/local-database";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("local-database");

test("a failed setup closes the client and rethrows its error", async () => {
  const databasePath = join(await temporaryDirectory(), "local.db");
  const failure = new Error("setup failed");
  let setUp: Client | undefined;
  const opening = openLocalClient(
    databasePath,
    async (client) => {
      setUp = client;
      throw failure;
    },
    { busyTimeoutMs: 50 },
  );
  await expect(opening).rejects.toBe(failure);
  expect(setUp?.closed).toBe(true);
});
