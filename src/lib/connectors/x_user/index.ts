// The `x_user` connector (specification §6.3): the posts of one X account,
// through the X API v2 (paid for each post and each user that it returns).
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, sourceKey, xUserConfigSchema, type XUserConfig } from "../configs";
import { ConnectorError, type Candidate, type Connector, type ConnectorContext } from "../types";

import {
  X_TWEET_FIELDS,
  X_USER_TWEETS_MAX_RESULTS,
  X_USER_TWEETS_MIN_RESULTS,
  compareIds,
  isReply,
  isRepost,
  newestFirst,
  newestId,
  oldestId,
  postToItem,
  problemOfEmptyResult,
  remainingPostsOrThrow,
  xGet,
  xPostListSchema,
  xUserLookupSchema,
} from "./api";

export { costNote } from "./cost";

/** The cursor of an x_user source (sources.cursor). */
export interface XUserCursor {
  /** The numeric id of the account (from the first lookup). */
  userId: string;
  /** The newest post id that the app has read, or null. */
  sinceId: string | null;
  /**
   * A later poll that got a partial page (more new posts than max_results) leaves older new posts
   * unread. The next polls read them with since_id = sinceId and until_id = untilId; when no page is
   * left, sinceId moves to `newest`. Cursors from before this field have no gap.
   */
  gap?: { untilId: string; newest: string };
}

/** The number of posts of the first poll and of the preview (§6.3). */
export const X_USER_FIRST_POLL_POSTS = 5;

/** Paths of x.com that are not user names. */
const RESERVED_PATHS = new Set([
  "home", "explore", "search", "i", "settings", "hashtag", "intent", "share", "messages", "notifications",
  "compose", "login", "logout", "signup", "tos", "privacy", "about", "jobs", "download", "account", "lists",
  "communities", "premium", "verified", "following", "followers", "status", "x", "twitter", "help",
]);

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const PROFILE_LINK =
  /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(\/status(?:es)?\/\d+)?(?:[/?#][^\s]*)?$/i;

/** The handle that an entry names, with the confidence, or null. Pattern checks only. */
export function parseHandle(input: string, forced: boolean): { username: string; confidence: number } | null {
  const entry = input.trim();
  if (entry === "" || /\s/.test(entry)) return null;

  const at = /^@([A-Za-z0-9_]{1,15})$/.exec(entry);
  if (at) return { username: at[1]!, confidence: 0.9 };

  const link = PROFILE_LINK.exec(entry);
  if (link) {
    const username = link[1]!;
    if (RESERVED_PATHS.has(username.toLowerCase())) return null;
    // A link to a post names its author: a little less sure that the person wants the account.
    return { username, confidence: link[2] ? 0.8 : 0.95 };
  }

  if (forced && HANDLE.test(entry)) return { username: entry, confidence: 0.6 };
  return null;
}

function candidateFor(username: string, confidence: number, ctx: ConnectorContext): Candidate {
  const warnings: string[] = [];
  if (!ctx.env.has("X_BEARER_TOKEN")) warnings.push("Needs an X API token (X_BEARER_TOKEN).");
  return {
    type: "x_user",
    name: `@${username}`,
    description: `Posts of @${username} on X (no replies). Each post that the app reads costs about $0.005.`,
    url: `https://x.com/${username}`,
    config: { username, includeReposts: false } satisfies XUserConfig,
    confidence,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Looks up the account id (one User: Read). */
async function lookupUser(ctx: ConnectorContext, username: string): Promise<{ id: string; username: string }> {
  if (!ctx.usage.take("x_users", 1)) {
    throw new ConnectorError("budget", "The daily limit of X user lookups is used. The next check runs after midnight (UTC).");
  }
  const what = `@${username}`;
  const body = await xGet(ctx, `/users/by/username/${encodeURIComponent(username)}`, { "user.fields": "protected" }, what);
  const parsed = xUserLookupSchema.safeParse(body);
  if (!parsed.success) throw new ConnectorError("bad_response", "The X API returned a user that the app cannot read.");
  const user = parsed.data.data;
  if (!user) {
    throw problemOfEmptyResult(parsed.data.errors, what) ?? new ConnectorError("not_found", `The X account ${what} does not exist.`);
  }
  if (user.protected) {
    throw new ConnectorError("blocked", `The posts of ${what} are protected. The app can read only public posts.`);
  }
  return { id: user.id, username: user.username };
}

export const connector: Connector<XUserConfig, XUserCursor> = {
  type: "x_user",
  label: SOURCE_TYPE_LABELS.x_user,
  description: "Posts of one X account. Each post that the app reads costs money at X.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.x_user.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.x_user.maxAgeDays,
  configSchema: xUserConfigSchema,
  needs: (env, config) => credentialNeeds("x_user", env, config),
  keyOf: (config) => sourceKey("x_user", config),

  async resolve(input, ctx, forced) {
    const found = parseHandle(input, forced);
    return found ? [candidateFor(found.username, found.confidence, ctx)] : [];
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const parsedConfig = xUserConfigSchema.parse(config);
    const what = `@${parsedConfig.username}`;
    const known = mode === "poll" && cursor && cursor.userId ? cursor : null;
    const sinceId = known?.sinceId ?? null;
    const gap = sinceId !== null ? known?.gap : undefined;

    // Check the post budget before any paid call.
    const remaining = remainingPostsOrThrow(ctx, X_USER_TWEETS_MIN_RESULTS);

    let userId: string;
    let username = parsedConfig.username;
    if (known) {
      userId = known.userId;
    } else {
      const user = await lookupUser(ctx, parsedConfig.username);
      userId = user.id;
      username = user.username;
    }

    // First poll and preview: the 5 newest posts. Later polls: up to `limit` new posts.
    const wanted = sinceId === null ? X_USER_FIRST_POLL_POSTS : limit;
    const maxResults = clamp(Math.min(wanted, remaining), X_USER_TWEETS_MIN_RESULTS, X_USER_TWEETS_MAX_RESULTS);

    const body = await xGet(
      ctx,
      `/users/${encodeURIComponent(userId)}/tweets`,
      {
        max_results: maxResults,
        exclude: parsedConfig.includeReposts ? "replies" : "replies,retweets",
        "tweet.fields": X_TWEET_FIELDS,
        since_id: sinceId ?? undefined,
        until_id: gap?.untilId,
      },
      what,
    );
    const parsed = xPostListSchema.safeParse(body);
    if (!parsed.success) throw new ConnectorError("bad_response", "The X API returned posts that the app cannot read.");
    const posts = parsed.data.data ?? [];
    // The account pays for each post that the response returned.
    ctx.usage.add("x_posts", posts.length);

    if (posts.length === 0) {
      const problem = problemOfEmptyResult(parsed.data.errors, what);
      if (problem) throw problem;
    }

    const kept = posts.filter((post) => !isReply(post) && (parsedConfig.includeReposts || !isRepost(post)));
    const items = newestFirst(kept.map((post) => postToItem(post, username))).slice(0, Math.max(0, limit));

    const meta = parsed.data.meta;
    const newest = newestId([...posts.map((post) => post.id), ...(meta?.newest_id ? [meta.newest_id] : [])]);
    const top = newestId([...(gap ? [gap.newest] : []), ...(newest !== null ? [newest] : [])]);
    // A later poll with a next page: older new posts are not read yet. Keep sinceId and read them next time.
    const oldest = meta?.oldest_id ?? oldestId(posts.map((post) => post.id));
    if (sinceId !== null && meta?.next_token && oldest !== null && top !== null) {
      const nextCursor: XUserCursor = { userId, sinceId, gap: { untilId: oldest, newest: top } };
      return { items, cursor: mode === "poll" ? nextCursor : null };
    }
    const nextCursor: XUserCursor = {
      userId,
      sinceId: top !== null && (sinceId === null || compareIds(top, sinceId) > 0) ? top : sinceId,
    };
    return { items, cursor: mode === "poll" ? nextCursor : null };
  },
};
