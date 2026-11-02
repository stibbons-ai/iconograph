import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";

/** A filesystem path, never a remote database URL, keeps Runs local (ADR-0005). */
export function localDatabaseUrl(databasePath: string): string {
  return pathToFileURL(resolve(databasePath)).href;
}

/** Mastra's storage; the Run tables (`LibsqlRunStore`) live in the same file. */
export function createLocalStore(databasePath: string) {
  return new LibSQLStore({ id: "iconograph-local", url: localDatabaseUrl(databasePath) });
}

/** Mastra's workflow snapshots in `storage`; throws when the store has none. */
export async function workflowsStore(storage: MastraCompositeStore | undefined) {
  const workflows = await storage?.getStore("workflows");
  if (!workflows) throw new Error("LibSQL workflow storage is unavailable");
  return workflows;
}
