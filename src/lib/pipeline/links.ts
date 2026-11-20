// The link join of §7.2: an item that links to (or is linked by) an item of
// another source joins that item's story with no model call.
import { getSqlite } from "@/lib/db/client";
import { recomputeJudgements } from "@/lib/ranking/recompute";
import { isRootUrl } from "@/lib/text";
import { DAY_MS, nowMs } from "@/lib/time";
import { LOW_SUBSTANCES, type Substance } from "@/lib/types";

import { feedsNeedingJudgement, itemTime, readItem, readLinks } from "./rows";

/** Only stories with an item in this period can take a link join. */
export const LINK_JOIN_WINDOW_MS = 14 * DAY_MS;
/** Rule (3) applies only to an item with at most this many links. */
export const LINK_RULE3_MAX_LINKS = 3;

export interface LinkJoin {
  storyId: number;
  substance: Substance;
  /** True when the story is promo or chatter: no silent join, the judge call decides. */
  lowSubstance: boolean;
}

/**
 * Finds the story that a pending item joins by a link (§7.2), or null.
 * A match is an item of a DIFFERENT source, in a story whose last item is at
 * most 14 days old, where (1) the canonical URLs are equal, (2) that item
 * links to this item's URL, or (3) this item (with at most 3 links) links to
 * that item's URL. Root URLs never count. Items of kind doc_change never join.
 * When several stories match, the one with the newest last item wins.
 */
export function findLinkJoin(itemId: number, now: number = nowMs()): LinkJoin | null {
  const item = readItem(itemId);
  if (!item || item.judgeStatus !== "pending" || item.kind === "doc_change") return null;

  const ownUrl = item.canonicalUrl && !isRootUrl(item.canonicalUrl) ? item.canonicalUrl : null;
  const links = readLinks(itemId);
  const rule3Links = links.length <= LINK_RULE3_MAX_LINKS ? links.filter((link) => !isRootUrl(link)) : [];
  if (ownUrl === null && rule3Links.length === 0) return null;

  const row = getSqlite()
    .prepare(
      `SELECT s.id AS storyId, s.substance AS substance
         FROM stories s
         JOIN items o ON o.story_id = s.id
        WHERE o.source_id != @sourceId
          AND s.last_item_at >= @since
          AND ((@own IS NOT NULL AND o.canonical_url = @own)
            OR (@own IS NOT NULL AND EXISTS (SELECT 1 FROM item_links l WHERE l.item_id = o.id AND l.url = @own))
            OR o.canonical_url IN (SELECT value FROM json_each(@links)))
        ORDER BY s.last_item_at DESC, s.id DESC
        LIMIT 1`,
    )
    .get({ sourceId: item.sourceId, since: now - LINK_JOIN_WINDOW_MS, own: ownUrl, links: JSON.stringify(rule3Links) }) as
    | { storyId: number; substance: Substance }
    | undefined;
  if (!row) return null;
  return { storyId: row.storyId, substance: row.substance, lowSubstance: LOW_SUBSTANCES.includes(row.substance) };
}

/**
 * Puts an item into a story and updates item_count, source_count, and
 * last_item_at. Returns true when the source count changed.
 * Call it inside the transaction of the caller.
 */
export function attachItemToStory(itemId: number, storyId: number, now: number): boolean {
  const sqlite = getSqlite();
  const item = readItem(itemId);
  if (!item) return false;
  const before = sqlite.prepare("SELECT source_count AS n FROM stories WHERE id = ?").get(storyId) as
    | { n: number }
    | undefined;
  if (!before) return false;
  sqlite.prepare("UPDATE items SET story_id = ? WHERE id = ?").run(storyId, itemId);
  sqlite
    .prepare(
      `UPDATE stories
          SET item_count = (SELECT COUNT(*) FROM items WHERE story_id = @storyId),
              source_count = (SELECT COUNT(DISTINCT source_id) FROM items WHERE story_id = @storyId),
              last_item_at = MAX(last_item_at, @time),
              updated_at = @now
        WHERE id = @storyId`,
    )
    .run({ storyId, time: Math.min(now, itemTime(item)), now });
  const after = sqlite.prepare("SELECT source_count AS n FROM stories WHERE id = ?").get(storyId) as { n: number };
  return after.n !== before.n;
}

/**
 * The silent join of §7.2: the item joins the story; when no feed needs a
 * judgement, the item is `judged`. Else it stays `pending` for the
 * single-story mode of §7.3. Returns the feeds that need a judgement.
 * Call it inside an IMMEDIATE transaction.
 */
export function silentJoin(itemId: number, storyId: number, now: number): number[] {
  const item = readItem(itemId);
  if (!item) return [];
  attachItemToStory(itemId, storyId, now);
  const needed = feedsNeedingJudgement(storyId, item.sourceId);
  if (needed.length === 0) {
    getSqlite()
      .prepare(
        `UPDATE items SET judge_status = 'judged', judged_at = ?, judge_locked_until = NULL, next_judge_at = NULL
          WHERE id = ?`,
      )
      .run(now, itemId);
  }
  // The source count (term C) and the "source of this feed" test changed for every feed.
  recomputeJudgements({ storyIds: [storyId] });
  return needed;
}
