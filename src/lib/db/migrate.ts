import path from "node:path";

import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const MIGRATION_LOCK_TIMEOUT_MS = 60_000;

/** The folder with the SQL migrations. The path starts at the project root. */
export function migrationsFolder(): string {
  // The comment stops the file tracing of Turbopack for this path.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), "drizzle");
}

/**
 * Applies the pending migrations from the `drizzle/` folder.
 *
 * The drizzle migrator reads the last applied migration BEFORE it starts its
 * transaction. Thus two processes that start at the same moment can both
 * decide to apply the same migration. The guard is a lock that all processes
 * share: an exclusive transaction on a small SQLite file next to the
 * database (`<database>.migrate.lock`). The second process waits for the
 * lock, then the migrator finds no pending migration. The operating system
 * releases the lock if the process stops, so a stale lock is not possible.
 *
 * `beforeMigrate` and `afterMigrate` run while the process holds the lock.
 * Use them for setup that only one process can do at a time (the change to
 * WAL mode before the migrations, the seed after them).
 */
export function applyMigrations<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  databaseFile: string,
  beforeMigrate?: () => void,
  afterMigrate?: () => void,
): void {
  const run = () => {
    beforeMigrate?.();
    migrate(db, { migrationsFolder: migrationsFolder() });
    afterMigrate?.();
  };

  if (databaseFile === ":memory:" || databaseFile === "") {
    run();
    return;
  }

  const lock = new Database(`${databaseFile}.migrate.lock`, {
    timeout: MIGRATION_LOCK_TIMEOUT_MS,
  });
  try {
    lock.exec("BEGIN EXCLUSIVE");
    try {
      run();
    } finally {
      lock.exec("ROLLBACK");
    }
  } finally {
    lock.close();
  }
}
