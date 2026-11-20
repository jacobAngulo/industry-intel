import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { runSeed } from "@/lib/seed";

import { applyMigrations } from "./migrate";
import { resolveDatabasePathFrom } from "./path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
export type Sqlite = Database.Database;

export type DbHandle = { db: Db; sqlite: Sqlite; file: string };

const BUSY_TIMEOUT_MS = 5000;

// The handle is on globalThis. Thus it survives the hot reload of the Next.js
// dev server, and all bundles of one process share one connection.
const globalForDb = globalThis as typeof globalThis & {
  __industryIntelDb?: DbHandle;
};

/** The absolute path of the SQLite file (DATABASE_PATH, default ./data/app.db). */
export function resolveDatabasePath(): string {
  return resolveDatabasePathFrom(process.env.DATABASE_PATH);
}

/**
 * Runs the seed of the first run (specification §12) when the settings row
 * `seeded_at` is absent. One IMMEDIATE transaction holds the test, the seed,
 * and the `seeded_at` row, so two processes never both seed.
 * runSeed returns false when it wrote nothing: then no row is written.
 *
 * During the seed, getDb() and getSqlite() return this same connection, so
 * the seed can call code that uses them. A nested `db.transaction()` is a
 * savepoint (better-sqlite3).
 */
function seedIfNeeded(handle: DbHandle): void {
  const { db, sqlite } = handle;
  const previous = globalForDb.__industryIntelDb;
  globalForDb.__industryIntelDb = handle;
  try {
    sqlite
      .transaction(() => {
        const seeded = sqlite.prepare("SELECT 1 FROM settings WHERE key = 'seeded_at'").get();
        if (seeded) return;
        if (!runSeed(db)) return;
        const now = Date.now();
        sqlite
          .prepare(
            `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('seeded_at', ?, ?, 'Starter set')
             ON CONFLICT (key) DO NOTHING`,
          )
          .run(JSON.stringify(now), now);
      })
      .immediate();
  } finally {
    globalForDb.__industryIntelDb = previous;
  }
}

/**
 * Opens one SQLite file, sets the pragmas, applies the pending migrations,
 * and (with `seed: true`) runs the seed of the first run.
 * App code uses getDb(). Tests use installTestDb() from "@/test/helpers".
 */
export function openDatabase(file: string, options: { seed?: boolean } = {}): DbHandle {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    applyMigrations(
      db,
      file,
      () => {
        // The change to WAL needs a lock on the full file, so it runs behind
        // the migration lock. The mode stays in the file after that.
        sqlite.pragma("journal_mode = WAL");
      },
      () => {
        // The seed also runs behind the migration lock.
        if (options.seed) seedIfNeeded({ db, sqlite, file });
      },
    );
    sqlite.pragma("synchronous = NORMAL");
    return { db, sqlite, file };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function getHandle(): DbHandle {
  globalForDb.__industryIntelDb ??= openDatabase(resolveDatabasePath(), { seed: true });
  return globalForDb.__industryIntelDb;
}

/**
 * Opens the database of this process when it is not open: migrations, then
 * the seed. getDb() and getSqlite() call it. A process can call it at start
 * so that a failure shows early.
 */
export function ensureDatabase(): void {
  getHandle();
}

/**
 * The drizzle database of this process. The first call opens the file,
 * applies the migrations, and runs the seed. An import of this module opens
 * nothing.
 *
 * The web process and the worker process write to the same file. For a
 * transaction that reads and then writes, use
 * `db.transaction(fn, { behavior: "immediate" })`. A default (deferred)
 * transaction can fail with "database is locked" (SQLITE_BUSY_SNAPSHOT).
 */
export function getDb(): Db {
  return getHandle().db;
}

/** The raw better-sqlite3 handle, for raw SQL (for example FTS5 queries). */
export function getSqlite(): Sqlite {
  return getHandle().sqlite;
}

/** Closes the database of this process. The next getDb() call opens it again. */
export function closeDb(): void {
  const handle = globalForDb.__industryIntelDb;
  if (!handle) return;
  globalForDb.__industryIntelDb = undefined;
  if (handle.sqlite.open) handle.sqlite.close();
}

/**
 * Makes getDb() and getSqlite() return the given handle (tests, and scripts
 * that must open a file with no seed). `null` removes the handle and closes
 * nothing: the caller closes its own database.
 */
export function setDbHandleForTests(handle: DbHandle | null): void {
  globalForDb.__industryIntelDb = handle ?? undefined;
}

export type TestDb = {
  db: Db;
  sqlite: Sqlite;
  /** The path of the temporary SQLite file. */
  file: string;
  /** Closes the database and deletes the temporary folder. */
  cleanup: () => void;
};

/**
 * Makes a new SQLite file in a temporary folder and applies all migrations.
 * It does not run the seed unless `seed: true`. It does not touch the
 * database of getDb(): for that, use installTestDb() from "@/test/helpers".
 */
export function createTestDb(options: { seed?: boolean } = {}): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "industry-intel-test-"));
  const removeDir = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const { db, sqlite, file } = openDatabase(path.join(dir, "test.db"), { seed: options.seed ?? false });
    return {
      db,
      sqlite,
      file,
      cleanup: () => {
        if (sqlite.open) sqlite.close();
        removeDir();
      },
    };
  } catch (error) {
    removeDir();
    throw error;
  }
}
