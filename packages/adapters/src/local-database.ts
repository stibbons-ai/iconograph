// Apart from Mastra's storage (`storage.ts`), so a command that only needs a
// client (e.g. `prices`) doesn't load Mastra.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Client, createClient } from "@libsql/client";

/** A filesystem path, never a remote database URL, keeps Runs local (ADR-0005). */
export function localDatabaseUrl(databasePath: string): string {
  return pathToFileURL(resolve(databasePath)).href;
}

export interface LocalClientOptions {
  /** How long one statement waits, synchronously, on a lock held elsewhere (LibSQL `timeout`). */
  busyTimeoutMs: number;
  /** Wraps the client before `setup`; the wrapped one is set up and returned. */
  wrapClient?: ((client: Client) => Client) | undefined;
}

/**
 * A LibSQL client on the local file at `databasePath` (`localDatabaseUrl`),
 * once `setup` (tables, checks) has run on it. A failed `setup` closes the
 * client and rethrows its error.
 */
export async function openLocalClient(
  databasePath: string,
  setup: (client: Client) => Promise<unknown>,
  { busyTimeoutMs, wrapClient }: LocalClientOptions,
): Promise<Client> {
  const created = createClient({ url: localDatabaseUrl(databasePath), timeout: busyTimeoutMs });
  const client = wrapClient?.(created) ?? created;
  try {
    await setup(client);
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}
