import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LibSQLStore } from "@mastra/libsql";

/** A filesystem path, not a remote database URL, keeps this tracer local. */
export function createLocalStore(databasePath: string) {
  return new LibSQLStore({
    id: "iconograph-local",
    url: pathToFileURL(resolve(databasePath)).href,
  });
}
