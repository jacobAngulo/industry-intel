// Reddit (specification §6.3): the public `.json` listing with no login. On
// 403 or 429 the connector throws `blocked` with the message of the
// specification. With REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET it takes an
// application-only token (client credentials) and reads oauth.reddit.com.
// Never the RSS feed.
//
// Checked live on 2026-11-20: https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=30
// answers 403 (an HTML page) to this server, with the app User-Agent too.
// The OAuth flow and the listing shape come from the Reddit API documentation.
import { z } from "zod";

import { extractLinks } from "@/lib/text";

import type { CommunityConfig } from "../configs";
import { ConnectorError, type Candidate, type ConnectorContext, type FetchResult, type RawItem } from "../types";
import {
  checkStatus,
  itemLinks,
  itemText,
  num,
  parseJson,
  previewCount,
  readCursor,
  selectNew,
  send,
  str,
  type CommunityCursor,
} from "./shared";

export type RedditConfig = Extract<CommunityConfig, { variant: "reddit" }>;

export const REDDIT_BLOCKED_MESSAGE =
  "Reddit refuses requests from this server. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.";
const WHAT = "Reddit";

const LISTING_PATH: Record<RedditConfig["listing"], { path: string; query: string }> = {
  top_day: { path: "top", query: "t=day&" },
  hot: { path: "hot", query: "" },
  new: { path: "new", query: "" },
};

/** The listing path and query of a config, for example "r/LocalLLaMA/top?t=day&limit=30&raw_json=1" (no ".json"). */
function listingParts(config: RedditConfig, count: number): { path: string; query: string } {
  const l = LISTING_PATH[config.listing];
  return { path: `r/${encodeURIComponent(config.subreddit)}/${l.path}`, query: `${l.query}limit=${count}&raw_json=1` };
}

export function redditPublicUrl(config: RedditConfig, count = 30): string {
  const p = listingParts(config, count);
  return `https://www.reddit.com/${p.path}.json?${p.query}`;
}

export function redditOauthUrl(config: RedditConfig, count = 30): string {
  const p = listingParts(config, count);
  return `https://oauth.reddit.com/${p.path}?${p.query}`;
}

export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

// --- token (in memory, for each client id) ----------------------------------------

const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Forgets the cached tokens (tests). */
export function clearRedditTokensForTests(): void {
  tokens.clear();
}

async function getToken(ctx: ConnectorContext, clientId: string, clientSecret: string, fresh: boolean): Promise<string> {
  const cached = tokens.get(clientId);
  if (!fresh && cached && cached.expiresAt > ctx.now() + 60_000) return cached.token;
  tokens.delete(clientId);
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const res = await send(
    ctx,
    {
      url: REDDIT_TOKEN_URL,
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    },
    WHAT,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError(
      "needs_credentials",
      "Reddit refused REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET. Check the two values in the .env file.",
    );
  }
  if (res.status === 429) throw new ConnectorError("rate_limited", "Reddit limits the requests of this server now. The app tries again later.");
  checkStatus(res, WHAT, "Reddit has no token address (404).");
  const body = z
    .object({ access_token: z.string().min(1), expires_in: z.number().optional() })
    .safeParse(parseJson(res.text, WHAT));
  if (!body.success) {
    throw new ConnectorError(
      "needs_credentials",
      "Reddit gave no token for REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET. Check the two values in the .env file.",
    );
  }
  const expiresIn = Math.max(60, Math.min(body.data.expires_in ?? 3600, 86_400));
  tokens.set(clientId, { token: body.data.access_token, expiresAt: ctx.now() + expiresIn * 1000 });
  return body.data.access_token;
}

// --- listing --------------------------------------------------------------------

const postSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]{1,16}$/i),
    title: z.string().nullish(),
    selftext: z.string().nullish(),
    url: z.string().nullish(),
    permalink: z.string().nullish(),
    author: z.string().nullish(),
    created_utc: z.number().nullish(),
    score: z.number().nullish(),
    num_comments: z.number().nullish(),
    is_self: z.boolean().nullish(),
    subreddit: z.string().nullish(),
    link_flair_text: z.string().nullish(),
    over_18: z.boolean().nullish(),
    stickied: z.boolean().nullish(),
  })
  .passthrough();
const listingSchema = z
  .object({
    kind: z.string().optional(),
    data: z.object({ children: z.array(z.object({ kind: z.string().optional(), data: z.unknown() }).passthrough()) }).passthrough(),
  })
  .passthrough();

/** One listing child to a RawItem, or null. */
export function redditPostToItem(raw: unknown, subreddit: string): RawItem | null {
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return null;
  const post = parsed.data;
  const title = str(post.title);
  if (!title) return null;
  const permalink = post.permalink && post.permalink.startsWith("/") ? `https://www.reddit.com${post.permalink}` : null;
  const thread = permalink ?? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${post.id}/`;
  let link: string | undefined;
  if (!post.is_self && post.url) {
    if (/^https?:\/\//i.test(post.url)) link = post.url;
    else if (post.url.startsWith("/")) link = `https://www.reddit.com${post.url}`;
  }
  const selftext = post.selftext && post.selftext !== "[removed]" && post.selftext !== "[deleted]" ? post.selftext : "";
  const created = num(post.created_utc);
  const author = str(post.author);
  return {
    externalId: post.id,
    url: link ?? thread,
    title,
    ...(author && author !== "[deleted]" ? { author } : {}),
    ...(created !== undefined ? { publishedAt: Math.round(created * 1000) } : {}),
    kind: "discussion",
    text: itemText(selftext ? `${title}\n\n${selftext}` : title),
    links: itemLinks([link, thread, ...extractLinks(selftext)]),
    meta: {
      site: "reddit",
      subreddit: post.subreddit ?? subreddit,
      score: num(post.score) ?? 0,
      comments: num(post.num_comments) ?? 0,
      threadUrl: thread,
      ...(post.link_flair_text ? { flair: post.link_flair_text } : {}),
    },
  };
}

function blockedReason(text: string): string | null {
  try {
    const body = JSON.parse(text) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : null;
  } catch {
    return null;
  }
}

export async function fetchReddit(args: {
  config: RedditConfig;
  cursor: unknown;
  mode: "preview" | "poll";
  limit: number;
  ctx: ConnectorContext;
}): Promise<FetchResult<CommunityCursor>> {
  const { config, mode, limit, ctx } = args;
  const cursor = mode === "poll" ? readCursor(args.cursor, "reddit") : null;
  const clientId = ctx.env.redditClientId;
  const clientSecret = ctx.env.redditClientSecret;
  const oauth = Boolean(clientId && clientSecret);
  const notFound = `The subreddit r/${config.subreddit} does not exist.`;
  const conditional = {
    ...(cursor?.etag ? { etag: cursor.etag } : {}),
    ...(cursor?.lastModified ? { lastModified: cursor.lastModified } : {}),
  };

  let res;
  if (oauth && clientId && clientSecret) {
    const read = async (fresh: boolean) => {
      const token = await getToken(ctx, clientId, clientSecret, fresh);
      return send(ctx, { url: redditOauthUrl(config), headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, ...conditional }, WHAT);
    };
    res = await read(false);
    if (res.status === 401) res = await read(true);
    if (res.status === 401) {
      throw new ConnectorError("needs_credentials", "Reddit refused the token for REDDIT_CLIENT_ID. Check the two values in the .env file.");
    }
    if (res.status === 403) {
      const reason = blockedReason(res.text);
      throw new ConnectorError(
        "blocked",
        reason ? `Reddit refuses r/${config.subreddit} (${reason}).` : `Reddit refuses r/${config.subreddit} (status 403).`,
      );
    }
  } else {
    res = await send(ctx, { url: redditPublicUrl(config), headers: { Accept: "application/json" }, ...conditional }, WHAT);
    // §6.3: exactly this message on 403 or 429 (also for a private subreddit: the server cannot tell).
    if (res.status === 403 || res.status === 429) throw new ConnectorError("blocked", REDDIT_BLOCKED_MESSAGE);
  }
  if (res.notModified && cursor) return { items: [], cursor };
  checkStatus(res, WHAT, notFound);
  // An unknown subreddit can answer 200 with a redirect to the search page, or an empty listing.
  if (!/^\s*[{[]/.test(res.text)) {
    if (!oauth && /<html/i.test(res.text)) throw new ConnectorError("blocked", REDDIT_BLOCKED_MESSAGE);
    throw new ConnectorError("bad_response", "Reddit did not send a listing.");
  }
  const body = listingSchema.safeParse(parseJson(res.text, WHAT));
  if (!body.success) throw new ConnectorError("bad_response", "Reddit did not send a listing.");

  const items = body.data.data.children
    .filter((child) => child.kind === undefined || child.kind === "t3")
    .map((child) => redditPostToItem(child.data, config.subreddit))
    .filter((item): item is RawItem => item !== null)
    .filter((item) => ((item.meta as { score: number }).score ?? 0) >= config.minScore);

  if (mode === "preview") return { items: selectNew(items, null, previewCount(limit)).items, cursor: null };
  const picked = selectNew(items, cursor?.seenIds ?? null, limit);
  return {
    items: picked.items,
    cursor: {
      variant: "reddit",
      seenIds: picked.seenIds,
      ...(res.etag ? { etag: res.etag } : {}),
      ...(res.lastModified ? { lastModified: res.lastModified } : {}),
    },
  };
}

// --- resolve ------------------------------------------------------------------------

const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

function redditCandidate(subreddit: string, listing: RedditConfig["listing"], confidence: number, hasCredentials: boolean): Candidate {
  const config: RedditConfig = { variant: "reddit", subreddit, listing, minScore: 50 };
  const what = listing === "top_day" ? "Top posts of the day" : listing === "hot" ? "Hot posts" : "New posts";
  return {
    type: "community",
    name: `r/${subreddit}`,
    description: `${what} in r/${subreddit} with a score of at least 50.`,
    url: `https://www.reddit.com/r/${subreddit}/`,
    config,
    confidence,
    ...(hasCredentials
      ? {}
      : {
          warnings: [
            "Reddit can refuse requests from this server. If the preview fails, set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.",
          ],
        }),
  };
}

/** A reddit.com link to a subreddit, or null. */
export function resolveRedditUrl(url: URL, hasCredentials: boolean): Candidate[] | null {
  const host = url.hostname.toLowerCase();
  if (!/^(?:(?:www|old|new|np|m|sh)\.)?reddit\.com$/.test(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== "r" || !parts[1] || !SUBREDDIT.test(parts[1])) return [];
  const next = parts[2]?.toLowerCase();
  const listing: RedditConfig["listing"] = next === "new" ? "new" : next === "hot" ? "hot" : "top_day";
  return [redditCandidate(parts[1], listing, 0.95, hasCredentials)];
}

/** "r/name" or "/r/name", or null. */
export function resolveRedditText(text: string, hasCredentials: boolean): Candidate[] | null {
  const match = /^\/?r\/([A-Za-z0-9_]{2,21})\/?$/i.exec(text.trim());
  if (!match || !match[1]) return null;
  return [redditCandidate(match[1], "top_day", 0.95, hasCredentials)];
}

/** A low-confidence subreddit guess for one word typed with the Community type chosen. */
export function redditGuess(text: string, hasCredentials: boolean): Candidate | null {
  const word = text.trim();
  if (!SUBREDDIT.test(word)) return null;
  return redditCandidate(word, "top_day", 0.3, hasCredentials);
}
