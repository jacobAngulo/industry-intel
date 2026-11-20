// Small database reads that several pipeline steps share.
import { eq } from "drizzle-orm";

import { getDb, getSqlite } from "@/lib/db/client";
import { items, sources, stories, type ItemDbRow, type SourceDbRow, type StoryDbRow } from "@/lib/db/schema";
import { SOURCE_FILTER_EXCLUSION } from "./schemas";

export function readItem(itemId: number): ItemDbRow | null {
  return getDb().select().from(items).where(eq(items.id, itemId)).get() ?? null;
}

export function readStory(storyId: number): StoryDbRow | null {
  return getDb().select().from(stories).where(eq(stories.id, storyId)).get() ?? null;
}

export function readSource(sourceId: number): SourceDbRow | null {
  return getDb().select().from(sources).where(eq(sources.id, sourceId)).get() ?? null;
}

/** The time of an item for the story clock: its publish time, else the time it was fetched. */
export function itemTime(item: Pick<ItemDbRow, "publishedAt" | "fetchedAt">): number {
  return item.publishedAt ?? item.fetchedAt;
}

/** The canonical links of an item (table item_links). */
export function readLinks(itemId: number): string[] {
  const rows = getSqlite().prepare("SELECT url FROM item_links WHERE item_id = ? ORDER BY url").all(itemId) as Array<{
    url: string;
  }>;
  return rows.map((row) => row.url);
}

/** The ids of the active (not archived) feeds that use the source now. */
export function activeFeedIdsForSource(sourceId: number): number[] {
  const rows = getSqlite()
    .prepare(
      `SELECT f.id AS id FROM feeds f JOIN feed_sources fs ON fs.feed_id = f.id
        WHERE fs.source_id = ? AND f.archived_at IS NULL ORDER BY f.position, f.id`,
    )
    .all(sourceId) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * The feeds that need a judgement of the story because of an item of this
 * source (§7.2): the active feeds that use the source and that have no
 * judgement of the story, or whose judgement was excluded by the Ignore text
 * ('source filter') of a different source. A judgement whose item is gone
 * counts as "from a different source".
 */
export function feedsNeedingJudgement(storyId: number, sourceId: number): number[] {
  const rows = getSqlite()
    .prepare(
      `SELECT f.id AS id
         FROM feeds f
         JOIN feed_sources fs ON fs.feed_id = f.id AND fs.source_id = @sourceId
         LEFT JOIN judgements j ON j.feed_id = f.id AND j.story_id = @storyId
         LEFT JOIN items si ON si.id = j.source_item_id
        WHERE f.archived_at IS NULL
          AND (j.id IS NULL
               OR (j.exclusion = @sourceFilter AND (si.id IS NULL OR si.source_id != @sourceId)))
        ORDER BY f.position, f.id`,
    )
    .all({ storyId, sourceId, sourceFilter: SOURCE_FILTER_EXCLUSION }) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** Parses a JSON text column that raw SQL returns. Null for bad JSON. */
export function parseJsonText(text: unknown): unknown {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
