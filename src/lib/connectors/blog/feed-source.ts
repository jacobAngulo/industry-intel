// The feed reading that the blog, newsletter (feed variant), podcast, and
// youtube connectors share: conditional GET, parse, newest first, and the
// "seen ids" cursor.
import { z } from "zod";

import { NotAFeedError, parseFeed, type FeedEntry, type ParsedFeed } from "@/lib/feeds";
import { canonicalizeUrl, extractLinks, sha, truncate } from "@/lib/text";

import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type ConnectorContext, type RawItem } from "../types";
import { FEED_ACCEPT, assertOk, httpGet } from "./http";

/** The cursor of a feed-based source. */
export interface FeedCursor {
  etag?: string;
  lastModified?: string;
  /** Ids of the entries that the source returned or passed over, newest first. */
  seenIds: string[];
}

/** Only the newest entries of a feed take part in a poll. */
export const FEED_WINDOW = 50;
/** The most ids that the cursor keeps. */
export const SEEN_IDS_CAP = 300;

export const feedCursorSchema = z.object({
  etag: z.string().max(500).optional(),
  lastModified: z.string().max(200).optional(),
  seenIds: z.array(z.string()).max(5000).default([]),
});

/** The stored cursor, or null when it is absent or not a feed cursor. */
export function readFeedCursor(cursor: unknown): FeedCursor | null {
  if (cursor === null || cursor === undefined) return null;
  const parsed = feedCursorSchema.safeParse(cursor);
  if (!parsed.success) return null;
  const out: FeedCursor = { seenIds: parsed.data.seenIds };
  if (parsed.data.etag) out.etag = parsed.data.etag;
  if (parsed.data.lastModified) out.lastModified = parsed.data.lastModified;
  return out;
}

export type FeedDocument =
  | { notModified: true; etag?: string; lastModified?: string }
  | { notModified: false; feed: ParsedFeed; url: string; etag?: string; lastModified?: string };

export interface LoadFeedOptions {
  /** Used for the conditional GET. */
  cursor?: FeedCursor | null;
  maxBytes?: number;
  timeoutMs?: number;
  /** Names the address in error messages. Default "The feed address". */
  what?: string;
}

/** Fetches and parses a feed. A 304 answer gives { notModified: true }. */
export async function loadFeed(ctx: ConnectorContext, feedUrl: string, options: LoadFeedOptions = {}): Promise<FeedDocument> {
  const what = options.what ?? "The feed address";
  const res = await httpGet(ctx, feedUrl, {
    accept: FEED_ACCEPT,
    ...(options.cursor?.etag ? { etag: options.cursor.etag } : {}),
    ...(options.cursor?.lastModified ? { lastModified: options.cursor.lastModified } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  assertOk(res, what);
  const validators = {
    ...(res.etag ? { etag: res.etag } : {}),
    ...(res.lastModified ? { lastModified: res.lastModified } : {}),
  };
  if (res.notModified || res.status === 304) return { notModified: true, ...validators };
  let feed: ParsedFeed;
  try {
    feed = parseFeed(res.text, res.url || feedUrl);
  } catch (error) {
    if (error instanceof NotAFeedError) {
      throw new ConnectorError("bad_response", `${what} did not return a feed (RSS, Atom, or JSON Feed).`, { cause: error });
    }
    throw new ConnectorError("bad_response", `${what} returned a feed that the app cannot read.`, { cause: error });
  }
  return { notModified: false, feed, url: res.url || feedUrl, ...validators };
}

/**
 * Newest first. When every entry has a date, sort by date (stable). When an
 * entry has no date, keep the order of the feed (feeds list the newest first).
 */
export function newestFirst(entries: FeedEntry[]): FeedEntry[] {
  if (entries.some((e) => e.publishedAt === undefined)) return [...entries];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.publishedAt ?? 0) - (a.entry.publishedAt ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** A stable external id for an entry (very long ids become a hash). */
export function entryId(entry: FeedEntry): string {
  const id = entry.id.trim();
  if (id !== "" && id.length <= 300) return id;
  return `sha:${sha(id || `${entry.title}\n${entry.link ?? ""}\n${entry.publishedAt ?? ""}`)}`;
}

export interface SelectResult {
  /** The entries to return, newest first. */
  fresh: FeedEntry[];
  /** The new cursor ids (poll mode). */
  seenIds: string[];
}

/**
 * Picks the entries of a poll or a preview.
 * - preview, or a poll with no cursor: the `limit` newest entries that pass the filter.
 * - a poll with a cursor: the entries that the cursor has not seen and that pass the filter.
 * The new cursor marks every entry of the window as seen (also the entries that the filter drops).
 */
export function selectEntries(
  entries: FeedEntry[],
  args: { cursor: FeedCursor | null; mode: "preview" | "poll"; limit: number; keep?: (entry: FeedEntry) => boolean },
): SelectResult {
  const window = newestFirst(entries).slice(0, FEED_WINDOW);
  const keep = args.keep ?? (() => true);
  const limit = Math.max(0, Math.floor(args.limit));
  const seen = new Set(args.mode === "poll" && args.cursor ? args.cursor.seenIds : []);
  const fresh = window.filter((entry) => !seen.has(entryId(entry)) && keep(entry)).slice(0, limit);
  const seenIds = [...new Set([...window.map(entryId), ...(args.cursor?.seenIds ?? [])])].slice(0, SEEN_IDS_CAP);
  return { fresh, seenIds };
}

/** The cursor after a successful poll. */
export function nextCursor(doc: { etag?: string; lastModified?: string }, seenIds: string[]): FeedCursor {
  return {
    ...(doc.etag ? { etag: doc.etag } : {}),
    ...(doc.lastModified ? { lastModified: doc.lastModified } : {}),
    seenIds,
  };
}

/** At most 10 absolute http(s) links of the content, without the item's own address. */
export function contentLinks(htmlOrText: string, baseUrl: string | undefined, ownUrl?: string): string[] {
  const own = ownUrl ? canonicalizeUrl(ownUrl) : undefined;
  return extractLinks(htmlOrText, baseUrl)
    .filter((link) => /^https?:\/\//i.test(link) && link !== own)
    .slice(0, RAW_ITEM_MAX_LINKS);
}

/** Plain text capped at the RawItem limit. */
export function capText(text: string): string {
  return truncate(text.trim(), RAW_ITEM_MAX_TEXT);
}

/** The common mapping of a feed entry to a RawItem. */
export function entryToItem(entry: FeedEntry, kind: RawItem["kind"], feedUrl: string): RawItem {
  const item: RawItem = {
    externalId: entryId(entry),
    title: entry.title.trim() || "(untitled)",
    kind,
    text: capText(entry.text),
  };
  if (entry.link) item.url = entry.link;
  if (entry.author) item.author = entry.author;
  if (entry.publishedAt !== undefined) item.publishedAt = entry.publishedAt;
  const links = contentLinks(entry.html ?? entry.text, entry.link ?? feedUrl, entry.link);
  if (links.length > 0) item.links = links;
  return item;
}

/** True when most entries carry audio or video (a podcast feed). */
export function looksLikePodcast(feed: ParsedFeed): boolean {
  if (feed.entries.length === 0) return false;
  const media = feed.entries.filter((e) => /^(audio|video)\//i.test(e.enclosure?.type ?? "") || /\.(mp3|m4a|aac|ogg|opus|mp4)(\?|$)/i.test(e.enclosure?.url ?? ""));
  return media.length * 2 >= feed.entries.length;
}
