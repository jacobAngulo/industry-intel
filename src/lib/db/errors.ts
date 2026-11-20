// SQLite error codes.
//
// drizzle reports a SQLite error in two forms:
// - a query of the query builder (`db.insert(...).run()`, `.get()`, `.all()`)
//   throws the SqliteError of better-sqlite3 itself: the code is `error.code`;
// - `db.run(sql`...`)` and the other raw calls throw a DrizzleQueryError:
//   the code is `error.cause.code`.
// Use sqliteErrorCode() so that the code is found in the two forms.

/** The SQLite code of an error (for example "SQLITE_CONSTRAINT_UNIQUE"), or null. */
export function sqliteErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_")) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True for a violation of a UNIQUE key or a PRIMARY KEY. */
export function isUniqueViolation(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/** True for a violation of a FOREIGN KEY. */
export function isForeignKeyViolation(error: unknown): boolean {
  return sqliteErrorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY";
}
