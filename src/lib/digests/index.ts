// The digests of specification §9.2. No model call.
//
// For each active feed with a digest frequency that is not off:
//   end   = previousOccurrence(now)
//   due   = no digest of the feed has period_end >= end
//   start = period_end of the newest digest when that is at most 8 days
//           before end, else occurrenceBefore(end)
//   entries = the visible judgements of the feed whose
//             max(stories.fresh_at, judgements.created_at) is in [start, end),
//             by base_score descending, at most maxStories
// A row is stored also when it has no entry. The unique key
// (feed_id, period_end) makes a restart safe.
import { getSqlite } from "@/lib/db/client";
import { occurrenceBefore, previousOccurrence, zonedParts } from "@/lib/schedule";
import { DAY_MS } from "@/lib/time";
import {
  DEFAULT_DIGEST_MAX_STORIES,
  DIGEST_FREQUENCIES,
  STORY_CATEGORIES,
  type DigestEntry,
  type DigestFrequency,
  type DigestSettings,
  type StoryCategory,
} from "@/lib/types";

/** The newest digest starts the next period when it is at most this old (§9.2). */
export const DIGEST_CONTINUE_MS = 8 * DAY_MS;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const FREQUENCY_WORD: Record<Exclude<DigestFrequency, "off">, string> = {
  daily: "daily",
  weekdays: "weekday",
  weekly: "weekly",
};

/** "<feed name> — <daily | weekday | weekly> digest — <date of end in the feed time zone>". */
export function digestTitle(feedName: string, digest: DigestSettings, end: number): string {
  const word = digest.frequency === "off" ? "daily" : FREQUENCY_WORD[digest.frequency];
  const p = zonedParts(end, digest.timeZone);
  return `${feedName} — ${word} digest — ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

function parseDigestSettings(text: string): DigestSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const frequency = (DIGEST_FREQUENCIES as readonly unknown[]).includes(v.frequency) ? (v.frequency as DigestFrequency) : "off";
  const maxStories =
    typeof v.maxStories === "number" && Number.isInteger(v.maxStories) && v.maxStories > 0
      ? v.maxStories
      : DEFAULT_DIGEST_MAX_STORIES;
  return {
    frequency,
    weekday: typeof v.weekday === "number" ? v.weekday : 1,
    time: typeof v.time === "string" ? v.time : "",
    timeZone: typeof v.timeZone === "string" ? v.timeZone : "UTC",
    maxStories,
  };
}

function parseStringList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

type FeedRow = { id: number; name: string; digest: string };
type EntryRow = {
  storyId: number;
  headline: string;
  summary: string;
  whyItMatters: string;
  suggestedAction: string | null;
  relevance: number;
  baseScore: number;
  primaryUrl: string | null;
  category: string;
  freshAt: number;
};

/** Creates the digests that are due at `now`. Returns the number of digests that it created. No model call. */
export function createDueDigests(now: number): number {
  const sqlite = getSqlite();
  const feeds = sqlite
    .prepare(
      `SELECT id, name, digest FROM feeds
       WHERE archived_at IS NULL ORDER BY position, id`,
    )
    .all() as FeedRow[];
  if (feeds.length === 0) return 0;

  const newestEnd = sqlite.prepare("SELECT MAX(period_end) AS periodEnd FROM digests WHERE feed_id = ?");
  const selectEntries = sqlite.prepare(
    `SELECT s.id AS storyId, s.headline, s.summary, j.why_it_matters AS whyItMatters,
            j.suggested_action AS suggestedAction, j.relevance, j.base_score AS baseScore,
            s.primary_url AS primaryUrl, s.category, s.fresh_at AS freshAt
     FROM judgements j JOIN stories s ON s.id = j.story_id
     WHERE j.feed_id = ? AND j.hidden_reason IS NULL
       AND MAX(s.fresh_at, j.created_at) >= ? AND MAX(s.fresh_at, j.created_at) < ?
     ORDER BY j.base_score DESC, s.fresh_at DESC, s.id DESC
     LIMIT ?`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO digests (feed_id, period_start, period_end, title, entries, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (feed_id, period_end) DO NOTHING`,
  );

  let created = 0;
  for (const feed of feeds) {
    const digest = parseDigestSettings(feed.digest);
    if (!digest || digest.frequency === "off") continue;
    const end = previousOccurrence(now, digest);
    if (end === null) continue;

    // One IMMEDIATE transaction for each feed: the due test, the read, and the write.
    const made = sqlite
      .transaction(() => {
        const newest = (newestEnd.get(feed.id) as { periodEnd: number | null }).periodEnd;
        if (newest !== null && newest >= end) return false;
        const start = newest !== null && end - newest <= DIGEST_CONTINUE_MS ? newest : occurrenceBefore(end, digest);

        const rows = selectEntries.all(feed.id, start, end, digest.maxStories) as EntryRow[];
        const entries: DigestEntry[] = rows.map((row) => ({
          storyId: row.storyId,
          headline: row.headline,
          // The full summary: the page cuts it to the summary length of the feed (render-time, §8.4).
          summary: parseStringList(row.summary),
          whyItMatters: row.whyItMatters,
          suggestedAction: row.suggestedAction,
          relevance: row.relevance,
          baseScore: row.baseScore,
          primaryUrl: row.primaryUrl,
          category: (STORY_CATEGORIES as readonly string[]).includes(row.category)
            ? (row.category as StoryCategory)
            : "other",
          freshAt: row.freshAt,
        }));
        const result = insert.run(feed.id, start, end, digestTitle(feed.name, digest, end), JSON.stringify(entries), now);
        return result.changes > 0;
      })
      .immediate();
    if (made) created += 1;
  }
  return created;
}
