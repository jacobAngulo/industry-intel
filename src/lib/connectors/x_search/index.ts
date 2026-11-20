// The `x_search` connector (specification §6.3): the top X posts for a
// keyword, through the recent search of the X API v2 (paid for each post that
// it returns). The likes threshold and the "keep top N" rule run in code
// after the read.
import { truncate } from "@/lib/text";
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, sourceKey, xSearchConfigSchema, type XSearchConfig } from "../configs";
import { ConnectorError, type Candidate, type Connector, type ConnectorContext } from "../types";
import {
  X_SEARCH_MAX_RESULTS,
  X_SEARCH_MIN_RESULTS,
  X_TWEET_FIELDS,
  isReply,
  isRepost,
  newestFirst,
  postToItem,
  remainingPostsOrThrow,
  xGet,
  xPostListSchema,
  type XPost,
} from "../x_user/api";

export { costNote } from "./cost";

/** The cursor of an x_search source (sources.cursor). */
export interface XSearchCursor {
  /** The end_time (epoch ms) of the last successful run: the start_time of the next one. */
  lastEndTime: number;
}

const HOUR = 3_600_000;
/** Each post has 2 hours to collect likes before a run reads it. */
export const X_SEARCH_SETTLE_MS = 2 * HOUR;
/** The window of the first run and of the preview. */
export const X_SEARCH_FIRST_WINDOW_MS = 24 * HOUR;
/** The recent search reaches 7 days back; keep a margin. */
const X_SEARCH_MAX_AGE_MS = 7 * 24 * HOUR - 10 * 60_000;
/** A window shorter than this is not worth a request. */
const MIN_WINDOW_MS = 60_000;

/** RFC 3339 with whole seconds, as the X API documents it (2026-11-20T08:00:00Z). */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function floorSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** The full search query: the words of the person plus the fixed operators. */
export function buildSearchQuery(config: Pick<XSearchConfig, "query" | "lang">): string {
  return `(${config.query.trim()}) -is:retweet -is:reply lang:${config.lang.toLowerCase()}`;
}

/** Keeps posts with at least `minLikes` likes, then the `keepTop` posts with the most likes (search order breaks ties). */
export function selectTopPosts(posts: XPost[], minLikes: number, keepTop: number): XPost[] {
  return posts
    .map((post, index) => ({ post, index, likes: post.public_metrics?.like_count ?? 0 }))
    .filter((entry) => entry.likes >= minLikes)
    .sort((a, b) => b.likes - a.likes || a.index - b.index)
    .slice(0, Math.max(0, keepTop))
    .map((entry) => entry.post);
}

function looksLikeUrlOrAddress(entry: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry) ||
    /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(entry)
  );
}

/** The search text and the confidence for one entry, or null. Pattern checks only. */
export function parseKeyword(input: string, forced: boolean): { query: string; confidence: number } | null {
  const entry = input.trim();
  if (entry === "" || /[\r\n]/.test(entry)) return null;

  // A link to an X search page: take its query.
  const searchLink = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/search\?(\S+)$/i.exec(entry);
  if (searchLink) {
    const q = new URLSearchParams(searchLink[1]).get("q")?.trim();
    return q ? { query: q, confidence: 0.95 } : null;
  }

  // An explicit hint: "x: agent evals", "twitter: …", "x keyword: …".
  const hint = /^(?:x|twitter|x keyword|x search)\s*:\s*(.+)$/i.exec(entry);
  if (hint && !/^\/\//.test(hint[1]!)) return { query: hint[1]!.trim(), confidence: 0.85 };

  if (looksLikeUrlOrAddress(entry)) return null;
  // A single @handle is an X user, not a keyword (unless the person chose this type).
  if (/^@\w+$/.test(entry)) return forced ? { query: entry, confidence: 0.5 } : null;
  if (entry.length < 2) return null;
  if (forced) return { query: entry, confidence: 0.9 };
  if (/^#\w{2,}$/.test(entry)) return { query: entry, confidence: 0.5 };
  return { query: entry, confidence: 0.3 };
}

function candidateFor(query: string, confidence: number, ctx: ConnectorContext): Candidate[] {
  const parsed = xSearchConfigSchema.safeParse({ query });
  if (!parsed.success) return [];
  const config = parsed.data;
  const warnings: string[] = [];
  if (!ctx.env.has("X_BEARER_TOKEN")) warnings.push("Needs an X API token (X_BEARER_TOKEN).");
  return [
    {
      type: "x_search",
      name: truncate(`X: ${config.query}`, 120),
      description: `Top X posts for "${truncate(config.query, 80)}": at least ${config.minLikes} likes, the top ${config.keepTop} of each run. Each run reads up to ${config.maxPostsPerRun} posts (about $0.005 each).`,
      url: `https://x.com/search?q=${encodeURIComponent(config.query)}&f=top`,
      config,
      confidence,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  ];
}

export const connector: Connector<XSearchConfig, XSearchCursor> = {
  type: "x_search",
  label: SOURCE_TYPE_LABELS.x_search,
  description: "The top X posts for a keyword search. Each post that the app reads costs money at X.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.x_search.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.x_search.maxAgeDays,
  configSchema: xSearchConfigSchema,
  needs: (env, config) => credentialNeeds("x_search", env, config),
  keyOf: (config) => sourceKey("x_search", config),

  async resolve(input, ctx, forced) {
    const found = parseKeyword(input, forced);
    return found ? candidateFor(found.query, found.confidence, ctx) : [];
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const parsedConfig = xSearchConfigSchema.parse(config);
    const now = ctx.now();
    const end = floorSecond(now - X_SEARCH_SETTLE_MS);
    const previous = mode === "poll" && cursor && Number.isFinite(cursor.lastEndTime) ? cursor.lastEndTime : null;
    // First run and preview: from now - 24 h. Later runs: from the end of the last run (at most 7 days back).
    const start = floorSecond(Math.max(previous ?? now - X_SEARCH_FIRST_WINDOW_MS, now - X_SEARCH_MAX_AGE_MS));

    // Nothing new to read yet (a check soon after the last one): no paid call.
    if (end - start < MIN_WINDOW_MS) {
      return { items: [], cursor: mode === "poll" ? { lastEndTime: previous ?? end } : null };
    }

    const remaining = remainingPostsOrThrow(ctx, X_SEARCH_MIN_RESULTS);
    const wanted = mode === "preview" ? X_SEARCH_MIN_RESULTS : parsedConfig.maxPostsPerRun;
    const maxResults = Math.min(X_SEARCH_MAX_RESULTS, Math.max(X_SEARCH_MIN_RESULTS, Math.min(wanted, remaining)));

    const body = await xGet(
      ctx,
      "/tweets/search/recent",
      {
        query: buildSearchQuery(parsedConfig),
        max_results: maxResults,
        sort_order: "relevancy",
        start_time: isoSeconds(start),
        end_time: isoSeconds(end),
        "tweet.fields": X_TWEET_FIELDS,
        expansions: "author_id",
        "user.fields": "username",
      },
      `the search "${truncate(parsedConfig.query, 60)}"`,
    );
    const parsed = xPostListSchema.safeParse(body);
    if (!parsed.success) throw new ConnectorError("bad_response", "The X API returned posts that the app cannot read.");
    const posts = parsed.data.data ?? [];
    // The account pays for each post that the response returned.
    ctx.usage.add("x_posts", posts.length);

    const usernames = new Map<string, string>();
    for (const user of parsed.data.includes?.users ?? []) usernames.set(user.id, user.username);

    const eligible = posts.filter((post) => !isRepost(post) && !isReply(post));
    const top = selectTopPosts(eligible, parsedConfig.minLikes, parsedConfig.keepTop);
    const items = newestFirst(
      top.map((post) => {
        const item = postToItem(post, post.author_id ? (usernames.get(post.author_id) ?? null) : null);
        item.meta = { ...item.meta, query: parsedConfig.query };
        return item;
      }),
    ).slice(0, Math.max(0, limit));

    return { items, cursor: mode === "poll" ? { lastEndTime: end } : null };
  },
};
