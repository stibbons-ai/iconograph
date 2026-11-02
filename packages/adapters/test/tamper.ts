import { Database } from "bun:sqlite";

/**
 * Change a Run database behind the store's back, e.g. to stage a storage
 * fault or write a row the store never would. Throws what SQLite throws.
 */
export function tamper(databasePath: string, sql: string, ...args: (string | number | null)[]) {
  const db = new Database(databasePath);
  try {
    db.run(sql, args);
  } finally {
    db.close();
  }
}
