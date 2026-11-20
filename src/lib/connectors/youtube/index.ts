// The `youtube` connector (specification §6.3): the videos of a channel or a
// playlist, from the public Atom feeds (title and description; no captions).
import type { FeedEntry } from "@/lib/feeds";
import { decodeEntities } from "@/lib/text";
import { LIMITS, SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import {
  entryToItem,
  loadFeed,
  nextCursor,
  readFeedCursor,
  selectEntries,
  type FeedCursor,
} from "../blog/feed-source";
import { PAGE_ACCEPT, assertOk, httpGet, inputUrl, metaContent } from "../blog/http";
import { credentialNeeds, sourceKey, youtubeConfigSchema, type YoutubeConfig } from "../configs";
import { ConnectorError, type Candidate, type Connector, type ConnectorContext, type RawItem } from "../types";

export type YoutubeCursor = FeedCursor;

export const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";

export function channelFeedUrl(channelId: string): string {
  return `${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`;
}
export function playlistFeedUrl(playlistId: string): string {
  return `${FEED_BASE}?playlist_id=${encodeURIComponent(playlistId)}`;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

export type YoutubeLink =
  | { kind: "channel_id"; channelId: string }
  | { kind: "channel_page"; pageUrl: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "video"; videoId: string; playlistId?: string };

/** Reads a YouTube address. Null when the address is not a channel, playlist, or video link. */
export function parseYoutubeUrl(url: URL): YoutubeLink | null {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const list = url.searchParams.get("list") ?? undefined;
  if (host === "youtu.be") {
    const id = segments[0];
    if (!id || !VIDEO_ID.test(id)) return null;
    return { kind: "video", videoId: id, ...(list && PLAYLIST_ID.test(list) ? { playlistId: list } : {}) };
  }
  if (!/^(?:www\.|m\.|music\.)?youtube\.com$/.test(host)) return null;
  const [first, second] = segments;
  if (!first) return null;
  if (first === "channel" && second && CHANNEL_ID.test(second)) return { kind: "channel_id", channelId: second };
  if (first === "playlist") return list && PLAYLIST_ID.test(list) ? { kind: "playlist", playlistId: list } : null;
  if (first === "watch") {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) return { kind: "video", videoId: v, ...(list && PLAYLIST_ID.test(list) ? { playlistId: list } : {}) };
    return list && PLAYLIST_ID.test(list) ? { kind: "playlist", playlistId: list } : null;
  }
  if (["shorts", "live", "embed", "v"].includes(first)) {
    return second && VIDEO_ID.test(second) ? { kind: "video", videoId: second } : null;
  }
  if (first.startsWith("@") && /^@[\w.-]{1,100}$/.test(first)) {
    return { kind: "channel_page", pageUrl: `https://www.youtube.com/${encodeURIComponent(first).replace("%40", "@")}` };
  }
  if ((first === "c" || first === "user") && second && /^[\w.-]{1,100}$/.test(second)) {
    return { kind: "channel_page", pageUrl: `https://www.youtube.com/${first}/${encodeURIComponent(second)}` };
  }
  return null;
}

function isConsentPage(finalUrl: string): boolean {
  try {
    const host = new URL(finalUrl).hostname.toLowerCase();
    return host.startsWith("consent.");
  } catch {
    return false;
  }
}

const CONSENT_MESSAGE =
  "YouTube answered with its cookie consent page instead of the channel page. Paste the channel address in the form youtube.com/channel/UC… instead.";

/** The channel id and title of a channel page (the canonical link, else externalId, else itemprop). */
export function channelFromPage(html: string): { channelId: string; title?: string } | null {
  const canonical = /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/i.exec(html)?.[1];
  const external = /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1];
  const identifier = /<meta\b[^>]*itemprop="(?:identifier|channelId)"[^>]*content="(UC[A-Za-z0-9_-]{22})"/i.exec(html)?.[1];
  const channelId = canonical ?? external ?? identifier;
  if (!channelId) return null;
  const title = decodeEntities(metaContent(html, "og:title") ?? "").trim();
  return { channelId, ...(title ? { title } : {}) };
}

/** The channel id of a watch page: the "videoDetails" block, else the most frequent "channelId". */
export function channelOfVideoPage(html: string): string | null {
  const details = html.indexOf('"videoDetails"');
  if (details >= 0) {
    const m = /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html.slice(details, details + 20_000));
    if (m?.[1]) return m[1];
  }
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/g)) {
    const id = m[1] ?? "";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

async function fetchPage(ctx: ConnectorContext, url: string, what: string): Promise<string> {
  const res = await httpGet(ctx, url, { accept: PAGE_ACCEPT, timeoutMs: 15_000, maxBytes: 6_000_000 });
  if (isConsentPage(res.url)) throw new ConnectorError("blocked", CONSENT_MESSAGE);
  assertOk(res, what);
  return res.text;
}

/** The title of a channel or a playlist from its feed; null when the feed does not answer. */
async function feedTitle(ctx: ConnectorContext, feedUrl: string): Promise<{ title: string; count: number } | null> {
  try {
    const doc = await loadFeed(ctx, feedUrl, { what: "The YouTube feed" });
    if (doc.notModified) return null;
    return { title: doc.feed.title, count: doc.feed.entries.length };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return null;
  }
}

function channelCandidate(channelId: string, title: string, confidence: number, warnings: string[] = []): Candidate {
  const name = cut(title || `YouTube channel ${channelId}`, LIMITS.name);
  const config: YoutubeConfig = youtubeConfigSchema.parse({ variant: "channel", channelId, title: cut(name, LIMITS.oneLine), includeShorts: false });
  return {
    type: "youtube",
    name,
    description: "Videos of this YouTube channel (title and description). Shorts are left out unless you switch them on.",
    url: `https://www.youtube.com/channel/${channelId}`,
    config,
    confidence,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function playlistCandidate(playlistId: string, title: string, count: number, confidence: number): Candidate {
  const name = cut(title || `YouTube playlist ${playlistId}`, LIMITS.name);
  const config: YoutubeConfig = youtubeConfigSchema.parse({ variant: "playlist", playlistId, title: cut(name, LIMITS.oneLine) });
  return {
    type: "youtube",
    name,
    description: `Videos of this YouTube playlist (${count} in the feed now; title and description).`,
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
    config,
    confidence,
  };
}

async function resolveLink(link: YoutubeLink, ctx: ConnectorContext): Promise<Candidate[]> {
  switch (link.kind) {
    case "channel_id": {
      const feed = await feedTitle(ctx, channelFeedUrl(link.channelId));
      if (feed) return [channelCandidate(link.channelId, feed.title, 0.95)];
      return [channelCandidate(link.channelId, "", 0.7, ["The channel feed did not answer now. Check the channel address."])];
    }
    case "channel_page": {
      const html = await fetchPage(ctx, link.pageUrl, "The YouTube channel page");
      const found = channelFromPage(html);
      if (!found) throw new ConnectorError("bad_response", "The YouTube page did not show a channel id.");
      return [channelCandidate(found.channelId, found.title ?? "", 0.95)];
    }
    case "playlist": {
      const feed = await feedTitle(ctx, playlistFeedUrl(link.playlistId));
      if (!feed) return [];
      return [playlistCandidate(link.playlistId, feed.title, feed.count, 0.95)];
    }
    case "video": {
      const out: Candidate[] = [];
      const html = await fetchPage(ctx, `https://www.youtube.com/watch?v=${link.videoId}`, "The YouTube video page");
      const channelId = channelOfVideoPage(html);
      if (channelId) {
        const feed = await feedTitle(ctx, channelFeedUrl(channelId));
        out.push(channelCandidate(channelId, feed?.title ?? "", feed ? 0.9 : 0.7));
      }
      if (link.playlistId) {
        const feed = await feedTitle(ctx, playlistFeedUrl(link.playlistId));
        if (feed) out.push(playlistCandidate(link.playlistId, feed.title, feed.count, 0.85));
      }
      return out;
    }
  }
}

/** True for a YouTube Short: the feed links a Short as /shorts/<id> (checked on 2026-11-20). */
export function isShort(entry: FeedEntry): boolean {
  return /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\//i.test(entry.link ?? "");
}

export function videoItem(entry: FeedEntry, feedUrl: string): RawItem {
  const item = entryToItem(entry, "video", feedUrl);
  const videoId = typeof entry.extra["yt:videoId"] === "string" ? entry.extra["yt:videoId"] : undefined;
  item.meta = { ...(videoId ? { videoId } : {}), short: isShort(entry) };
  return item;
}

export const connector: Connector<YoutubeConfig, YoutubeCursor> = {
  type: "youtube",
  label: SOURCE_TYPE_LABELS.youtube,
  description: "Videos of a YouTube channel or playlist (title and description).",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.youtube.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.youtube.maxAgeDays,
  configSchema: youtubeConfigSchema,
  needs: (env, config) => credentialNeeds("youtube", env, config),
  keyOf: (config) => sourceKey("youtube", config),

  async resolve(input, ctx, forced) {
    const text = input.trim();
    let url = inputUrl(text);
    // With the type chosen, "@handle" or a bare channel id is a YouTube channel.
    if (!url && forced && /^@[\w.-]{1,100}$/.test(text)) url = new URL(`https://www.youtube.com/${text}`);
    if (!url && forced && CHANNEL_ID.test(text)) url = new URL(`https://www.youtube.com/channel/${text}`);
    if (!url) return [];
    const link = parseYoutubeUrl(url);
    if (!link) return [];
    return resolveLink(link, ctx);
  },

  async fetch({ config, cursor: rawCursor, mode, limit, ctx }) {
    const cfg = youtubeConfigSchema.parse(config);
    const cursor = readFeedCursor(rawCursor);
    const feedUrl = cfg.variant === "channel" ? channelFeedUrl(cfg.channelId) : playlistFeedUrl(cfg.playlistId);
    const doc = await loadFeed(ctx, feedUrl, {
      cursor: mode === "poll" ? cursor : null,
      what: cfg.variant === "channel" ? "The YouTube channel feed" : "The YouTube playlist feed",
    });
    if (doc.notModified) {
      return { items: [], cursor: mode === "poll" ? nextCursor({ ...cursor, ...doc }, cursor?.seenIds ?? []) : null };
    }
    const keepShorts = cfg.variant === "playlist" || cfg.includeShorts;
    const selected = selectEntries(doc.feed.entries, {
      cursor,
      mode,
      limit,
      ...(keepShorts ? {} : { keep: (entry: FeedEntry) => !isShort(entry) }),
    });
    return {
      items: selected.fresh.map((entry) => videoItem(entry, doc.url)),
      cursor: mode === "poll" ? nextCursor(doc, selected.seenIds) : null,
    };
  },
};
