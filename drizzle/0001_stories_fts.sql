-- Custom SQL migration file (made with `npm run db:generate -- --custom --name=stories_fts`).
-- drizzle-kit does not know virtual tables, so this file is hand-written.
-- The full-text index of the stories: rowid = stories.id. The columns hold
-- the headline, the summary sentences as joined text, and the entities as
-- joined text. The code in src/lib/db/fts.ts keeps the table in sync.
CREATE VIRTUAL TABLE `stories_fts` USING fts5(`headline`, `summary`, `entities`, tokenize = 'porter unicode61');
