// The `podcast` connector (specification §6.3): one item for each episode
// (title + show notes), or the published transcript when the feed has one.
import { parseDuration, type FeedEntry, type ParsedFeed } from "@/lib/feeds";
import { truncate } from "@/lib/text";
import { LIMITS, SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { feedName, isOtherTypeHost } from "../blog";
import { findFeeds } from "../blog/discover";
import {
  capText,
  entryToItem,
  loadFeed,
  looksLikePodcast,
  nextCursor,
  readFeedCursor,
  selectEntries,
  type FeedCursor,
} from "../blog/feed-source";
import { httpGet, inputUrl, shortDate } from "../blog/http";
import { credentialNeeds, podcastConfigSchema, sourceKey, type PodcastConfig } from "../configs";
import type { Candidate, Connector, ConnectorContext, RawItem } from "../types";
import {
  appleIdOf,
  lookupShow,
  nameMatch,
  normalizeName,
  searchShows,
  spotifyShow,
  spotifyShowIdOf,
  type DirectoryShow,
} from "./directory";
import { pickTranscript, transcriptToText } from "./transcript";

export type PodcastCursor = FeedCursor;

/** Podcast feeds are large (the All-In feed was 4.3 MB with 446 episodes on 2026-11-20). */
export const PODCAST_FEED_MAX_BYTES = 30_000_000;
export const TRANSCRIPT_MAX_BYTES = 5_000_000;
/** Transcripts are fetched only for this many of the newest episodes of a poll (and of a preview). */
export const TRANSCRIPT_FETCHES = { poll: 8, preview: 3 } as const;
/** A transcript with less text than this is not used. */
const MIN_TRANSCRIPT_CHARS = 200;
const DAY_MS = 86_400_000;

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function showCandidate(show: DirectoryShow, confidence: number, warnings: string[] = []): Candidate {
  const config: PodcastConfig = podcastConfigSchema.parse({
    feedUrl: show.feedUrl,
    show: cut(show.name || show.artist || "Podcast", LIMITS.oneLine),
    itunesId: show.itunesId,
    transcripts: true,
  });
  const parts = [show.artist, show.genre, show.episodes !== undefined ? `${show.episodes} episodes` : undefined];
  if (show.latest !== undefined) parts.push(`newest ${shortDate(show.latest)}`);
  return {
    type: "podcast",
    name: cut(show.name || show.artist || "Podcast", LIMITS.name),
    description: parts.filter(Boolean).join(" · ") || "Podcast in the Apple directory.",
    ...(show.appleUrl ? { url: show.appleUrl } : {}),
    config,
    confidence: Math.round(confidence * 100) / 100,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function feedCandidate(feedUrl: string, feed: ParsedFeed, confidence: number): Candidate {
  const name = feedName(feed, "", feedUrl);
  const config: PodcastConfig = podcastConfigSchema.parse({ feedUrl, show: cut(name, LIMITS.oneLine), transcripts: true });
  const n = feed.entries.length;
  const withTranscript = feed.entries.slice(0, 20).some((e) => pickTranscript(e.extra["podcast:transcript"]) !== null);
  const warnings: string[] = [];
  if (!looksLikePodcast(feed)) warnings.push("This feed has few or no audio episodes.");
  if (n === 0) warnings.push("The feed has no episodes yet.");
  return {
    type: "podcast",
    name,
    description: `Podcast feed with ${n} episode${n === 1 ? "" : "s"}. ${withTranscript ? "Episodes have transcripts." : "Show notes only (no transcripts)."}`,
    url: feed.siteUrl ?? feedUrl,
    config,
    confidence,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Ranks directory matches: the name match and the order of the directory. */
function rankShows(query: string, shows: DirectoryShow[], publisher?: string | null): Array<{ show: DirectoryShow; score: number }> {
  const pub = publisher ? normalizeName(publisher) : "";
  return shows
    .map((show, index) => {
      let score = 0.6 * nameMatch(query, show) + 0.4 * (1 - index / Math.max(shows.length, 1));
      if (pub !== "" && normalizeName(show.artist) === pub) score += 0.2;
      return { show, score: Math.min(1, score) };
    })
    .sort((a, b) => b.score - a.score);
}

const FEEDISH_PATH = /(rss|feed|podcast|\.xml$|\.rss$)/i;

async function resolveUrl(url: URL, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]> {
  const appleId = appleIdOf(url);
  if (appleId !== null) {
    const show = await lookupShow(ctx, appleId);
    return show ? [showCandidate(show, 0.95)] : [];
  }

  const spotifyId = spotifyShowIdOf(url);
  if (spotifyId !== null) {
    const info = await spotifyShow(ctx, spotifyId);
    const term = info.title ?? info.oembedTitle;
    if (!term) return [];
    const shows = await searchShows(ctx, term, 5);
    const ranked = rankShows(term, shows, info.publisher).filter((r) => info.title === null || nameMatch(term, r.show) > 0);
    return ranked.slice(0, 3).map(({ show, score }, index) => {
      const warnings = [
        info.title
          ? `Found in the Apple directory by the Spotify show title "${cut(term, 80)}". Check that it is the same show.`
          : "Spotify gave only the title of an episode, not of the show. Check that it is the same show.",
      ];
      const base = info.title ? (index === 0 ? 0.9 : 0.6) : 0.35;
      return showCandidate(show, Math.min(base, 0.4 + 0.5 * score), warnings);
    });
  }

  if (!forced && isOtherTypeHost(url)) return [];
  if (!forced && !FEEDISH_PATH.test(url.pathname + url.search) && !/^(feeds?|rss)\./i.test(url.hostname)) return [];

  if (forced) {
    const found = await findFeeds(ctx, url.href);
    return found.feeds.map((f) => feedCandidate(f.feedUrl, f.feed, looksLikePodcast(f.feed) ? 0.95 : 0.5));
  }
  try {
    const doc = await loadFeed(ctx, url.href, { maxBytes: PODCAST_FEED_MAX_BYTES, timeoutMs: 30_000 });
    if (doc.notModified || !looksLikePodcast(doc.feed)) return [];
    return [feedCandidate(doc.url, doc.feed, 0.95)];
  } catch {
    return [];
  }
}

async function resolveName(text: string, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]> {
  const shows = await searchShows(ctx, text, forced ? 5 : 3);
  const ranked = rankShows(text, shows);
  return ranked
    .filter((r) => forced || nameMatch(text, r.show) > 0)
    .map(({ show, score }) => showCandidate(show, forced ? 0.5 + 0.4 * score : 0.2 + 0.2 * score));
}

/** Adds the transcript to the newest episodes that have one (§6.3 transcript rule). */
async function addTranscripts(
  pairs: Array<{ entry: FeedEntry; item: RawItem }>,
  ctx: ConnectorContext,
  max: number,
  maxAgeDays: number,
): Promise<void> {
  const oldest = ctx.now() - maxAgeDays * DAY_MS;
  for (const { entry, item } of pairs.slice(0, max)) {
    if (item.publishedAt === undefined || item.publishedAt < oldest) continue;
    const ref = pickTranscript(entry.extra["podcast:transcript"]);
    if (!ref) continue;
    try {
      const res = await httpGet(ctx, ref.url, { accept: ref.type || "*/*", maxBytes: TRANSCRIPT_MAX_BYTES, timeoutMs: 20_000 });
      if (!res.ok) continue;
      const text = transcriptToText(res.text, ref.format);
      if (text.length < MIN_TRANSCRIPT_CHARS) continue;
      const showNotes = item.text;
      item.text = capText(text);
      item.meta = { ...(item.meta ?? {}), basis: "transcript", transcriptUrl: ref.url, showNotes: truncate(showNotes, 2000) };
    } catch (error) {
      // A transcript that fails leaves the show notes; only a stopped check ends the loop.
      if (ctx.signal?.aborted) throw error;
    }
  }
}

export function episodeItem(entry: FeedEntry, feedUrl: string): RawItem {
  const item = entryToItem(entry, "episode", feedUrl);
  const meta: Record<string, unknown> = { basis: "show_notes" };
  const duration = parseDuration(entry.extra["itunes:duration"]);
  if (duration !== undefined && duration > 0) meta.durationSeconds = duration;
  if (entry.enclosure?.url) meta.audioUrl = entry.enclosure.url;
  item.meta = meta;
  return item;
}

export const connector: Connector<PodcastConfig, PodcastCursor> = {
  type: "podcast",
  label: SOURCE_TYPE_LABELS.podcast,
  description: "Episodes of a podcast: the show notes, or the transcript when the feed has one.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.podcast.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.podcast.maxAgeDays,
  configSchema: podcastConfigSchema,
  needs: (env, config) => credentialNeeds("podcast", env, config),
  keyOf: (config) => sourceKey("podcast", config),

  async resolve(input, ctx, forced) {
    const text = input.trim();
    if (text === "") return [];
    const url = inputUrl(text);
    if (url) return resolveUrl(url, ctx, forced);
    // A handle or a sender is not a podcast name.
    if (text.startsWith("@") || text.includes("@") || text.length > 100 || text.length < 2) return [];
    return resolveName(text, ctx, forced);
  },

  async fetch({ config, cursor: rawCursor, mode, limit, ctx }) {
    const cfg = podcastConfigSchema.parse(config);
    const cursor = readFeedCursor(rawCursor);
    const doc = await loadFeed(ctx, cfg.feedUrl, {
      cursor: mode === "poll" ? cursor : null,
      maxBytes: PODCAST_FEED_MAX_BYTES,
      timeoutMs: 45_000,
      what: "The podcast feed",
    });
    if (doc.notModified) {
      return { items: [], cursor: mode === "poll" ? nextCursor({ ...cursor, ...doc }, cursor?.seenIds ?? []) : null };
    }
    const selected = selectEntries(doc.feed.entries, { cursor, mode, limit });
    const pairs = selected.fresh.map((entry) => ({ entry, item: episodeItem(entry, doc.url) }));
    if (cfg.transcripts) await addTranscripts(pairs, ctx, TRANSCRIPT_FETCHES[mode], SOURCE_TYPE_DEFAULTS.podcast.maxAgeDays);
    return { items: pairs.map((p) => p.item), cursor: mode === "poll" ? nextCursor(doc, selected.seenIds) : null };
  },
};
