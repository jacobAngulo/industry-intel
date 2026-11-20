import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` compares src/lib/db/schema.ts with the snapshots in
// drizzle/meta. It does not open the database.
// Do not use `drizzle-kit push`: it does not know the hand-written tables
// (for example the FTS5 tables) and it does not write a migration.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_PATH || "./data/app.db",
  },
});
