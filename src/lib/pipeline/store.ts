// Storing the items of a successful poll (§7.2). No model call.
import { getConnector } from "@/lib/connectors/registry";
import { RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type RawItem } from "@/lib/connectors/types";
import { getSqlite } from "@/lib/db/client";
import type { SourceDbRow } from "@/lib/db/schema";
import { canonicalizeUrl, normalizeForHash, sha } from "@/lib/text";
import { DAY_MS } from "@/lib/time";
import type { SkipReason } from "@/lib/types";

import { findLinkJoin, silentJoin } from "./links";
import { activeFeedIdsForSource } from "./rows";

/** The first successful poll of a source queues only its newest items for the model. */
export const FIRST_RUN_JUDGE_LIMIT = 8;
/** A guard for the stored title (the model sees at most a part of it). */
const MAX_TITLE = 500;

type Prepared = {
  raw: RawItem;
  title: string;
  text: string;
  canonicalUrl: string | null;
  links: string[];
  skip: SkipReason | null;
};

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function prepare(raw: RawItem): Prepared {
  const title = raw.title.trim().slice(0, MAX_TITLE);
  const text = raw.text.slice(0, RAW_ITEM_MAX_TEXT);
  const links: string[] = [];
  for (const link of raw.links ?? []) {
    if (!isHttpUrl(link)) continue;
    const canonical = canonicalizeUrl(link);
    if (!links.includes(canonical)) links.push(canonical);
    if (links.length >= RAW_ITEM_MAX_LINKS) break;
  }
  return {
    raw,
    title,
    text,
    canonicalUrl: raw.url && isHttpUrl(raw.url) ? canonicalizeUrl(raw.url) : null,
    links,
    skip: null,
  };
}

/** The skip rules of §7.2 that look at one item alone, in their order. */
function ownSkipReason(item: Prepared, now: number, maxAgeMs: number): SkipReason | null {
  if (item.raw.skip === "baseline") return "baseline";
  if (item.title === "" && item.text.trim() === "") return "empty";
  if (item.raw.publishedAt !== undefined && item.raw.publishedAt < now - maxAgeMs) return "too_old";
  return null;
}

/**
 * Decides the skip reason of each new item, in the order of §7.2:
 * baseline, empty, too_old, first_run_cap (all but the 8 newest of the first
 * successful poll, among the items that the earlier rules keep), no_feed.
 */
function decideSkips(list: Prepared[], now: number, maxAgeMs: number, firstPoll: boolean, hasFeed: boolean): void {
  for (const item of list) item.skip = ownSkipReason(item, now, maxAgeMs);
  if (firstPoll) {
    const kept = list
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.skip === null)
      // Newest first; the connector order (newest first) breaks ties and orders undated items.
      .sort((a, b) => (b.item.raw.publishedAt ?? -Infinity) - (a.item.raw.publishedAt ?? -Infinity) || a.index - b.index);
    for (const { item } of kept.slice(FIRST_RUN_JUDGE_LIMIT)) item.skip = "first_run_cap";
  }
  if (!hasFeed) for (const item of list) item.skip ??= "no_feed";
}

/**
 * Stores the new items of one poll. A known (source_id, external_id) is left
 * unchanged. Pending items that link to a story of another source join it
 * (§7.2 link join). Call it inside the IMMEDIATE transaction that also saves
 * the cursor. Returns the number of new items.
 */
export function storeItems(source: SourceDbRow, rawItems: RawItem[], now: number, firstPoll: boolean): number {
  const sqlite = getSqlite();
  const exists = sqlite.prepare("SELECT 1 FROM items WHERE source_id = ? AND external_id = ?");
  const fresh: Prepared[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (!raw.externalId || seen.has(raw.externalId)) continue;
    seen.add(raw.externalId);
    if (exists.get(source.id, raw.externalId)) continue;
    fresh.push(prepare(raw));
  }
  if (fresh.length === 0) return 0;

  const maxAgeMs = getConnector(source.type).maxAgeDays * DAY_MS;
  decideSkips(fresh, now, maxAgeMs, firstPoll, activeFeedIdsForSource(source.id).length > 0);

  const insertItem = sqlite.prepare(
    `INSERT INTO items (source_id, external_id, url, canonical_url, title, author, published_at, fetched_at, kind,
                        content_text, content_hash, meta, judge_status, skip_reason)
     VALUES (@sourceId, @externalId, @url, @canonicalUrl, @title, @author, @publishedAt, @now, @kind,
             @text, @hash, @meta, @status, @skip)`,
  );
  const insertLink = sqlite.prepare("INSERT OR IGNORE INTO item_links (item_id, url) VALUES (?, ?)");

  const pendingIds: number[] = [];
  for (const item of fresh) {
    const result = insertItem.run({
      sourceId: source.id,
      externalId: item.raw.externalId,
      url: item.raw.url ?? null,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      author: item.raw.author ?? null,
      publishedAt: item.raw.publishedAt ?? null,
      now,
      kind: item.raw.kind,
      text: item.text,
      hash: sha(normalizeForHash(`${item.title}\n${item.text}`)),
      meta: JSON.stringify(item.raw.meta ?? {}),
      status: item.skip === null ? "pending" : "skipped",
      skip: item.skip,
    });
    const itemId = Number(result.lastInsertRowid);
    for (const link of item.links) insertLink.run(itemId, link);
    if (item.skip === null) pendingIds.push(itemId);
  }

  // After all inserts, so that the links of the whole poll are in place.
  for (const itemId of pendingIds) {
    const join = findLinkJoin(itemId, now);
    // A promo or chatter story gets no silent join: the judge call sees it as a certain candidate.
    if (join && !join.lowSubstance) silentJoin(itemId, join.storyId, now);
  }
  return fresh.length;
}
