import path from "node:path";

export const DEFAULT_DATABASE_PATH = "./data/app.db";

/**
 * The absolute path of the SQLite file for a DATABASE_PATH value.
 * An empty value gives the default ./data/app.db. A relative path starts at
 * the project root (the working directory of the process).
 */
export function resolveDatabasePathFrom(configured: string | undefined): string {
  const value = configured?.trim();
  // The comment stops the file tracing of Turbopack for this dynamic path.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), value || DEFAULT_DATABASE_PATH);
}

/** The absolute path of the default database file (./data/app.db). */
export function defaultDatabasePath(): string {
  return resolveDatabasePathFrom(undefined);
}
