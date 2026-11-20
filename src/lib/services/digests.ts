// The digest reads (specification §4.4, §9.2; §18.2 digests.ts). The worker
// writes the digests (createDueDigests). A digest row with no entry exists
// only so that its period is not tested again: the reads leave it out.
import { getSqlite } from "@/lib/db/client";
import type { DigestEntry } from "@/lib/types";

import { isRecord, parseJson } from "./_read-shared";
import type { DigestSummary, DigestView } from "./types";

type DigestRow = {
  id: number;
  title: string;
  periodStart: number;
  periodEnd: number;
  entryCount: number;
  createdAt: number;
};

/** A broken entries value counts as no entry (json_array_length would throw). */
const ENTRY_COUNT = "CASE WHEN json_valid(entries) THEN json_array_length(entries) ELSE 0 END";

function listRows(feedId: number, limit: number): DigestRow[] {
  return getSqlite()
    .prepare(
      `SELECT id, title, period_start AS periodStart, period_end AS periodEnd, ${ENTRY_COUNT} AS entryCount,
              created_at AS createdAt
         FROM digests
        WHERE feed_id = ? AND ${ENTRY_COUNT} > 0
        ORDER BY period_end DESC, id DESC LIMIT ?`,
    )
    .all(feedId, limit) as DigestRow[];
}

/** The digests of a feed that have entries, newest period first. */
export async function listDigests(feedId: number): Promise<DigestSummary[]> {
  return listRows(feedId, -1);
}

function parseEntries(text: unknown): DigestEntry[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((entry): entry is DigestEntry => isRecord(entry) && Number.isInteger(entry.storyId)) : [];
}

/** The ids of the stories that still exist (an entry of a deleted story shows as text, §4.4). */
function existingStoryIds(ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = getSqlite()
    .prepare("SELECT id FROM stories WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as Array<{ id: number }>;
  return new Set(rows.map((row) => row.id));
}

/** One digest of the feed with its snapshot entries, or null. */
export async function getDigest(feedId: number, digestId: number): Promise<DigestView | null> {
  const row = getSqlite()
    .prepare(
      `SELECT id, title, period_start AS periodStart, period_end AS periodEnd, created_at AS createdAt, entries
         FROM digests WHERE id = ? AND feed_id = ?`,
    )
    .get(digestId, feedId) as (Omit<DigestRow, "entryCount"> & { entries: string }) | undefined;
  if (!row) return null;
  const entries = parseEntries(row.entries);
  const existing = existingStoryIds(entries.map((entry) => entry.storyId));
  return {
    id: row.id,
    title: row.title,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    createdAt: row.createdAt,
    entryCount: entries.length,
    entries: entries.map((entry) => ({ ...entry, storyExists: existing.has(entry.storyId) })),
  };
}

/** The newest digest of the feed that has entries (the "Latest digest" link), or null. */
export async function latestDigest(feedId: number): Promise<DigestSummary | null> {
  return listRows(feedId, 1)[0] ?? null;
}
