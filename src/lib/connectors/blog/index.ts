// The `blog` connector (specification §6.3): the posts of a company blog or of
// one author, from the RSS / Atom / JSON feed.
import { decodeEntities, extractArticle } from "@/lib/text";
import type { FeedEntry, ParsedFeed } from "@/lib/feeds";
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS, LIMITS } from "@/lib/types";

import { blogConfigSchema, credentialNeeds, sourceKey, type BlogConfig } from "../configs";
import type { Candidate, Connector, ConnectorContext, RawItem } from "../types";
import { findFeeds, type FoundFeed } from "./discover";
import {
  capText,
  entryToItem,
  loadFeed,
  looksLikePodcast,
  nextCursor,
  readFeedCursor,
  selectEntries,
  type FeedCursor,
} from "./feed-source";
import { PAGE_ACCEPT, bareHost, httpGet, inputUrl, shortDate } from "./http";

export type BlogCursor = FeedCursor;

/** A feed entry with less text than this gets the article page when `fullText` is on. */
export const FULL_TEXT_MIN_CHARS = 500;
/** The most article pages for each poll (and for each preview). */
export const FULL_TEXT_MAX_FETCHES = { poll: 5, preview: 2 } as const;

/** Hosts that other connectors own: the blog connector skips them unless the person chose the type. */
const OTHER_TYPE_HOSTS = [
  "github.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "reddit.com",
  "old.reddit.com",
  "news.ycombinator.com",
  "arxiv.org",
  "open.spotify.com",
  "podcasts.apple.com",
  "itunes.apple.com",
];

export function isOtherTypeHost(url: URL): boolean {
  return OTHER_TYPE_HOSTS.includes(bareHost(url));
}

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The sections and authors filters of the config (empty = all; no case difference). */
export function entryFilter(config: Pick<BlogConfig, "sections" | "authors">): (entry: FeedEntry) => boolean {
  const sections = new Set(config.sections.map(norm).filter(Boolean));
  const authors = new Set(config.authors.map(norm).filter(Boolean));
  return (entry) => {
    if (sections.size > 0 && !entry.categories.some((c) => sections.has(norm(c)))) return false;
    if (authors.size > 0) {
      const names = (entry.author ?? "").split(/\s*(?:,|;|&|\band\b)\s*/i).map(norm).filter(Boolean);
      const whole = norm(entry.author ?? "");
      if (!authors.has(whole) && !names.some((n) => authors.has(n))) return false;
    }
    return true;
  };
}

/** Replaces the text of short entries with the article page text (at most `max` fetches). */
export async function addFullText(items: RawItem[], ctx: ConnectorContext, max: number): Promise<void> {
  let fetches = 0;
  for (const item of items) {
    if (fetches >= max) break;
    if (!item.url || item.text.length >= FULL_TEXT_MIN_CHARS) continue;
    fetches += 1;
    try {
      const res = await httpGet(ctx, item.url, { accept: PAGE_ACCEPT, timeoutMs: 15_000 });
      if (!res.ok) continue;
      const article = extractArticle(res.text, res.url || item.url);
      if (article.text.trim().length > item.text.length) {
        item.text = capText(article.text);
        item.meta = { ...(item.meta ?? {}), fullText: true };
      }
    } catch (error) {
      // A page that fails keeps the feed text; only a stopped check ends the loop.
      if (ctx.signal?.aborted) throw error;
    }
  }
}

/** Reads a feed and returns the items of a poll or a preview (shared with the newsletter feed variant). */
export async function fetchFeedItems(args: {
  feedUrl: string;
  cursor: unknown;
  mode: "preview" | "poll";
  limit: number;
  ctx: ConnectorContext;
  kind: RawItem["kind"];
  keep?: (entry: FeedEntry) => boolean;
  fullText?: boolean;
}): Promise<{ items: RawItem[]; cursor: FeedCursor | null }> {
  const cursor = readFeedCursor(args.cursor);
  const doc = await loadFeed(args.ctx, args.feedUrl, { cursor: args.mode === "poll" ? cursor : null });
  if (doc.notModified) {
    // Nothing changed: keep the seen ids, take the new validators.
    return { items: [], cursor: args.mode === "poll" ? nextCursor({ ...cursor, ...doc }, cursor?.seenIds ?? []) : null };
  }
  const selected = selectEntries(doc.feed.entries, {
    cursor,
    mode: args.mode,
    limit: args.limit,
    ...(args.keep ? { keep: args.keep } : {}),
  });
  const items = selected.fresh.map((entry) => {
    const item = entryToItem(entry, args.kind, doc.url);
    if (entry.categories.length > 0) item.meta = { categories: entry.categories.slice(0, 10) };
    return item;
  });
  if (args.fullText) await addFullText(items, args.ctx, FULL_TEXT_MAX_FETCHES[args.mode]);
  return { items, cursor: args.mode === "poll" ? nextCursor(doc, selected.seenIds) : null };
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The name of a candidate: the feed title, else the page title, else the host. */
export function feedName(feed: ParsedFeed, html: string, url: string): string {
  const pageTitle = decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "");
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // keep the address
  }
  return cut(feed.title || pageTitle || host, LIMITS.name);
}

/** "Feed with 10 posts. The newest is from 18 Nov 2026." */
export function feedDescription(feed: ParsedFeed, noun = "posts"): string {
  const n = feed.entries.length;
  if (n === 0) return "The feed has no entries yet.";
  const newest = Math.max(...feed.entries.map((e) => e.publishedAt ?? 0));
  const count = `Feed with ${n} ${n === 1 ? noun.replace(/s$/, "") : noun}.`;
  return newest > 0 ? `${count} The newest is from ${shortDate(newest)}.` : count;
}

export function blogCandidate(found: FoundFeed, html: string, pageUrl: string, confidence: number): Candidate {
  const feed = found.feed;
  const config: BlogConfig = blogConfigSchema.parse({
    feedUrl: found.feedUrl,
    ...(feed.siteUrl || pageUrl !== found.feedUrl ? { siteUrl: feed.siteUrl ?? pageUrl } : {}),
  });
  const warnings: string[] = [];
  let conf = confidence;
  if (looksLikePodcast(feed)) {
    warnings.push("This feed looks like a podcast. The Podcast type reads its episodes better.");
    conf = Math.min(conf, 0.4);
  }
  if (feed.entries.length === 0) warnings.push("The feed has no entries yet.");
  return {
    type: "blog",
    name: feedName(feed, html, found.feedUrl),
    description: feedDescription(feed),
    url: config.siteUrl ?? found.feedUrl,
    config,
    confidence: conf,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const connector: Connector<BlogConfig, BlogCursor> = {
  type: "blog",
  label: SOURCE_TYPE_LABELS.blog,
  description: "Posts of a company blog or of one author, from the RSS / Atom / JSON feed.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.blog.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.blog.maxAgeDays,
  configSchema: blogConfigSchema,
  needs: (env, config) => credentialNeeds("blog", env, config),
  keyOf: (config) => sourceKey("blog", config),

  async resolve(input, ctx, forced) {
    const url = inputUrl(input);
    if (!url) return [];
    if (!forced && isOtherTypeHost(url)) return [];
    const found = await findFeeds(ctx, url.href);
    return found.feeds.map((feed, index) => {
      let base = feed.via === "direct" ? 0.95 : feed.via === "link" ? 0.9 - index * 0.05 : 0.8;
      // A comments feed (WordPress "Comments Feed") is rarely what a person wants.
      if (/\/comments?\/(?:feed|rss)|[?&]feed=comments/i.test(feed.feedUrl)) base = Math.min(base, 0.5);
      return blogCandidate(feed, found.html, found.pageUrl, base);
    });
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const parsed = blogConfigSchema.parse(config);
    return fetchFeedItems({
      feedUrl: parsed.feedUrl,
      cursor,
      mode,
      limit,
      ctx,
      kind: "article",
      keep: entryFilter(parsed),
      fullText: parsed.fullText,
    });
  },
};
