// The connection that this process opened already, without the import of the
// database client. getEnv() reads the saved API keys through it (env.ts must
// stay light, and it must never open the database).
import type { DbHandle, Sqlite } from "./client";

/** The same global as in client.ts (it survives the hot reload of the dev server). */
const globalForDb = globalThis as typeof globalThis & { __industryIntelDb?: DbHandle };

/** The raw connection when this process opened the database already, else null. It never opens the file. */
export function openSqliteOrNull(): Sqlite | null {
  const handle = globalForDb.__industryIntelDb;
  return handle && handle.sqlite.open ? handle.sqlite : null;
}
