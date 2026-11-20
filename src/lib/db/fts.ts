// The full-text index of the stories: the FTS5 table `stories_fts`
// (hand-written migration drizzle/0001_stories_fts.sql). rowid = stories.id.
// The code that writes a story calls upsertStoryFts in the same transaction;
// the code that deletes a story calls deleteStoryFts.
import { logEvent } from "@/lib/log";

import { getSqlite } from "./client";

const MAX_MATCH_WORDS = 12;

/** Writes (or replaces) the index row of one story. */
export function upsertStoryFts(storyId: number, headline: string, summary: string[], entities: string[]): void {
  const sqlite = getSqlite();
  sqlite.prepare("DELETE FROM stories_fts WHERE rowid = ?").run(storyId);
  sqlite
    .prepare("INSERT INTO stories_fts (rowid, headline, summary, entities) VALUES (?, ?, ?, ?)")
    .run(storyId, headline, summary.join("\n"), entities.join("\n"));
}

/** Deletes the index row of one story. No row is not an error. */
export function deleteStoryFts(storyId: number): void {
  getSqlite().prepare("DELETE FROM stories_fts WHERE rowid = ?").run(storyId);
}

/**
 * Builds the MATCH text for searchStories: at most 12 words, each inside
 * double quotes with inner quotes removed, joined with " OR ".
 * Returns "" when no word stays.
 */
export function buildMatchText(words: string[]): string {
  const quoted: string[] = [];
  for (const word of words) {
    const clean = word.replace(/"/g, "").trim();
    if (!clean) continue;
    quoted.push(`"${clean}"`);
    if (quoted.length >= MAX_MATCH_WORDS) break;
  }
  return quoted.join(" OR ");
}

/**
 * Full-text search over the stories whose `last_item_at` is at or after
 * `sinceMs`, best match first. `rank` is the bm25 value of FTS5: a smaller
 * (more negative) number is a better match.
 * An empty MATCH text or an FTS syntax error returns [] (with a warn event
 * for the error); the function does not throw.
 */
export function searchStories(matchText: string, sinceMs: number, limit: number): Array<{ id: number; rank: number }> {
  if (!matchText.trim() || limit <= 0) return [];
  try {
    return getSqlite()
      .prepare(
        `SELECT s.id AS id, bm25(stories_fts) AS rank
           FROM stories_fts
           JOIN stories s ON s.id = stories_fts.rowid
          WHERE stories_fts MATCH ? AND s.last_item_at >= ?
          ORDER BY rank, s.id DESC
          LIMIT ?`,
      )
      .all(matchText, sinceMs, Math.floor(limit)) as Array<{ id: number; rank: number }>;
  } catch (error) {
    logEvent("warn", "fts", "The story search failed.", {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return [];
  }
}
