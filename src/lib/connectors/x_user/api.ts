// The shared X API v2 client of the x_user and x_search connectors
// (specification §6.3). Every request goes through ctx.http with the Bearer
// token from ctx.env. The token never goes into an error message, a log line,
// or an item.
//
// Interface facts (docs.x.com, read on 2026-11-20; no live call, because each
// post that the API returns costs money):
// - GET /2/users/by/username/{username}            -> { data: { id, name, username } } or 200 + { errors }
// - GET /2/users/{id}/tweets  max_results 5..100, exclude=replies,retweets, since_id, tweet.fields
// - GET /2/tweets/search/recent  max_results 10..100, start_time (last 7 days), end_time, sort_order=relevancy
// - Errors: { title, detail, type } (RFC 7807); 429 has the header x-rate-limit-reset (Unix seconds).
// - Price: Posts: Read $0.005 for each post returned; User: Read $0.010 for each user.
import { z } from "zod";

import { HttpError, type HttpResponse } from "@/lib/http/types";
import { canonicalizeUrl, decodeEntities, stripInvisible, truncate } from "@/lib/text";

import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type ConnectorContext, type RawItem } from "../types";

export const X_API_BASE = "https://api.x.com/2";

/** The fields that the connectors request for each post. */
export const X_TWEET_FIELDS = "created_at,author_id,conversation_id,entities,lang,note_tweet,public_metrics,referenced_tweets";

/** API limits of max_results. */
export const X_USER_TWEETS_MIN_RESULTS = 5;
export const X_USER_TWEETS_MAX_RESULTS = 100;
export const X_SEARCH_MIN_RESULTS = 10;
export const X_SEARCH_MAX_RESULTS = 100;

const X_TIMEOUT_MS = 20_000;
const X_MAX_BYTES = 3_000_000;

// --- response shapes (only the fields that the app reads) --------------------

const urlEntitySchema = z.object({
  url: z.string().optional(),
  expanded_url: z.string().optional(),
  unwound_url: z.string().optional(),
  display_url: z.string().optional(),
  media_key: z.string().optional(),
});

const entitiesSchema = z.object({ urls: z.array(urlEntitySchema).optional() });

const noteSchema = z.object({ text: z.string(), entities: entitiesSchema.optional() });

const referenceSchema = z.object({ type: z.string(), id: z.string() });

const metricsSchema = z.object({
  retweet_count: z.number().optional(),
  reply_count: z.number().optional(),
  like_count: z.number().optional(),
  quote_count: z.number().optional(),
  bookmark_count: z.number().optional(),
  impression_count: z.number().optional(),
});

export const xPostSchema = z.object({
  id: z.string().regex(/^\d{1,25}$/),
  text: z.string(),
  created_at: z.string().optional(),
  author_id: z.string().optional(),
  conversation_id: z.string().optional(),
  lang: z.string().optional(),
  entities: entitiesSchema.optional(),
  note_tweet: noteSchema.optional(),
  // Name in the OpenAPI reference 2.175; the guides use note_tweet. Read both.
  note_post: noteSchema.optional(),
  public_metrics: metricsSchema.optional(),
  referenced_tweets: z.array(referenceSchema).optional(),
  referenced_posts: z.array(referenceSchema).optional(),
});
export type XPost = z.infer<typeof xPostSchema>;

export const xUserSchema = z.object({
  id: z.string().regex(/^\d{1,25}$/),
  username: z.string(),
  name: z.string().optional(),
  protected: z.boolean().optional(),
});
export type XUser = z.infer<typeof xUserSchema>;

const problemSchema = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  type: z.string().optional(),
  value: z.string().optional(),
  resource_type: z.string().optional(),
});
type XProblem = z.infer<typeof problemSchema>;

const errorBodySchema = problemSchema.extend({ errors: z.array(problemSchema).optional() });

export const xPostListSchema = z.object({
  data: z.array(xPostSchema).optional(),
  includes: z.object({ users: z.array(xUserSchema).optional() }).optional(),
  meta: z
    .object({
      result_count: z.number().optional(),
      newest_id: z.string().optional(),
      oldest_id: z.string().optional(),
      /** Present when more posts match than max_results (a partial page). */
      next_token: z.string().optional(),
    })
    .optional(),
  errors: z.array(problemSchema).optional(),
});
export type XPostList = z.infer<typeof xPostListSchema>;

export const xUserLookupSchema = z.object({
  data: xUserSchema.optional(),
  errors: z.array(problemSchema).optional(),
});

// --- requests ------------------------------------------------------------------

/** The Bearer token, or ConnectorError kind needs_credentials. */
export function xToken(ctx: ConnectorContext): string {
  const token = ctx.env.xBearerToken;
  if (!token) {
    throw new ConnectorError(
      "needs_credentials",
      "Needs an X API token. Add X_BEARER_TOKEN to the .env file and start the app again.",
    );
  }
  return token;
}

/**
 * One GET to the X API. Returns the parsed JSON of a 2xx response; maps every
 * other outcome to a ConnectorError (see mapXError).
 */
export async function xGet(
  ctx: ConnectorContext,
  path: string,
  params: Record<string, string | number | undefined>,
  what: string,
): Promise<unknown> {
  const token = xToken(ctx);
  const url = new URL(X_API_BASE + path);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  let res: HttpResponse;
  try {
    res = await ctx.http.request({
      url: url.toString(),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: X_TIMEOUT_MS,
      maxBytes: X_MAX_BYTES,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      const message =
        error.kind === "timeout"
          ? "The X API did not answer in time. The next check tries again."
          : "The X API could not be reached. The next check tries again.";
      throw new ConnectorError("network", message, { cause: error });
    }
    throw new ConnectorError("network", "The X API could not be reached. The next check tries again.", { cause: error });
  }

  if (res.status < 200 || res.status >= 300) throw mapXError(res, what);

  try {
    return JSON.parse(res.text) as unknown;
  } catch {
    throw new ConnectorError("bad_response", "The X API returned a response that the app cannot read.");
  }
}

function readProblem(text: string): { top: XProblem; all: XProblem[] } {
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const { errors, ...top } = parsed.data;
      return { top, all: [top, ...(errors ?? [])] };
    }
  } catch {
    // Not JSON: use the status only.
  }
  return { top: {}, all: [] };
}

const CREDIT_WORDS = /credit|billing|payment|spend(ing)?[ -]?limit|usage[ -]?cap|insufficient (balance|funds)/i;

function isCreditProblem(problems: XProblem[]): boolean {
  return problems.some((p) => CREDIT_WORDS.test(`${p.title ?? ""} ${p.type ?? ""} ${p.detail ?? ""}`));
}

/** "14:05 UTC" for an epoch ms. */
function utcClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** The ConnectorError for a response with a status that is not 2xx. `what` names the request ("@name", "the search"). */
export function mapXError(res: HttpResponse, what: string): ConnectorError {
  const { top, all } = readProblem(res.text);
  // No credits at X is an account problem that a person must fix, not the app's own daily limit
  // (kind budget): kind blocked counts as a failure with the normal backoff.
  if (res.status === 402 || isCreditProblem(all)) {
    return new ConnectorError(
      "blocked",
      "The X API account has no credits left or reached its spending limit. Add credits in the X Developer Console.",
    );
  }
  switch (res.status) {
    case 401:
      return new ConnectorError(
        "needs_credentials",
        "The X API refused the token (401). Check X_BEARER_TOKEN in the .env file and start the app again.",
      );
    case 403:
      return new ConnectorError(
        "needs_credentials",
        "The X API refused access (403). The app of this token has no access to this endpoint. Check the app in the X Developer Console.",
      );
    case 404:
      return new ConnectorError("not_found", `The X API found nothing for ${what} (404).`);
    case 429: {
      const reset = Number(res.headers["x-rate-limit-reset"]);
      const error = new ConnectorError(
        "rate_limited",
        Number.isFinite(reset) && reset > 0
          ? `The X API rate limit is reached. It resets at ${utcClock(reset * 1000)}.`
          : "The X API rate limit is reached. The next check tries again.",
      );
      if (Number.isFinite(reset) && reset > 0) (error as XRateLimitedError).resetAt = reset * 1000;
      return error;
    }
    default:
      if (res.status >= 500) {
        return new ConnectorError("network", `The X API is not available now (status ${res.status}). The next check tries again.`);
      }
      return new ConnectorError(
        "bad_response",
        `The X API refused the request (status ${res.status})${top.detail ? `: ${truncate(top.detail, 200)}` : "."}`,
      );
  }
}

/** A rate_limited ConnectorError can carry the reset time (epoch ms). */
export type XRateLimitedError = ConnectorError & { resetAt?: number };

/**
 * A 200 response with `errors` and no `data` (a missing, suspended, or
 * protected account). Returns null when the errors do not explain an empty result.
 */
export function problemOfEmptyResult(errors: XProblem[] | undefined, what: string): ConnectorError | null {
  if (!errors || errors.length === 0) return null;
  if (isCreditProblem(errors)) return mapXError({ status: 402, ok: false, url: "", headers: {}, text: "", notModified: false }, what);
  const text = errors.map((p) => `${p.title ?? ""} ${p.type ?? ""} ${p.detail ?? ""}`).join(" ");
  if (/suspend/i.test(text)) return new ConnectorError("not_found", `The X account ${what} is suspended.`);
  if (/not-found|not found|could not find/i.test(text)) return new ConnectorError("not_found", `The X account ${what} does not exist.`);
  if (/not-authorized|authoriz|protected|forbidden/i.test(text)) {
    return new ConnectorError("blocked", `The posts of ${what} are protected. The app can read only public posts.`);
  }
  return new ConnectorError("bad_response", `The X API returned an error for ${what}: ${truncate(errors[0]?.detail ?? "unknown", 200)}`);
}

// --- posts to items ----------------------------------------------------------------

/** Compares two numeric post ids (they do not fit in a double). */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The newest id of a list, or null. */
export function newestId(ids: string[]): string | null {
  let best: string | null = null;
  for (const id of ids) if (best === null || compareIds(id, best) > 0) best = id;
  return best;
}

/** The oldest id of a list, or null. */
export function oldestId(ids: string[]): string | null {
  let best: string | null = null;
  for (const id of ids) if (best === null || compareIds(id, best) < 0) best = id;
  return best;
}

export function references(post: XPost): Array<{ type: string; id: string }> {
  return post.referenced_tweets ?? post.referenced_posts ?? [];
}

export function isRepost(post: XPost): boolean {
  return references(post).some((ref) => ref.type === "retweeted") || /^RT @\w+:/.test(post.text);
}

export function isReply(post: XPost): boolean {
  return references(post).some((ref) => ref.type === "replied_to");
}

const X_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for a t.co link, a pic.x.com link, or a link to X media (/photo/, /video/). */
function isMediaOrShortLink(url: string): boolean {
  const host = hostOf(url);
  if (host === null) return true;
  if (host === "t.co" || host === "pic.x.com" || host === "pic.twitter.com") return true;
  if (host.endsWith("twimg.com")) return true;
  if (X_HOSTS.has(host)) {
    try {
      return /\/(photo|video)\/\d+\/?$/.test(new URL(url).pathname);
    } catch {
      return true;
    }
  }
  return false;
}

/** A link of a post to itself (the "show more" link of a long post). */
function isSelfLink(url: string, postId: string): boolean {
  const host = hostOf(url);
  if (host === null || !X_HOSTS.has(host)) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith(`/status/${postId}`);
  } catch {
    return false;
  }
}

/** The expanded http(s) links of a post: no t.co links, no links to X media or to the post itself, canonical, at most 10. */
export function postLinks(post: XPost): string[] {
  const note = post.note_tweet ?? post.note_post;
  const entities = [...(note?.entities?.urls ?? []), ...(post.entities?.urls ?? [])];
  const out: string[] = [];
  for (const entity of entities) {
    if (entity.media_key) continue;
    const raw = (entity.unwound_url ?? entity.expanded_url ?? "").trim();
    if (!/^https?:\/\//i.test(raw) || isMediaOrShortLink(raw) || isSelfLink(raw, post.id)) continue;
    const canonical = canonicalizeUrl(raw);
    if (!out.includes(canonical)) out.push(canonical);
    if (out.length >= RAW_ITEM_MAX_LINKS) break;
  }
  return out;
}

/** The full plain text: note_tweet when present; t.co links replaced by the expanded link (media links removed). */
export function postText(post: XPost): string {
  const note = post.note_tweet ?? post.note_post;
  let text = note?.text ?? post.text;
  const entities = [...(note?.entities?.urls ?? []), ...(post.entities?.urls ?? [])];
  for (const entity of entities) {
    if (!entity.url) continue;
    const expanded = entity.unwound_url ?? entity.expanded_url ?? "";
    const replacement =
      entity.media_key || !expanded || isMediaOrShortLink(expanded) || isSelfLink(expanded, post.id) ? "" : expanded;
    text = text.split(entity.url).join(replacement);
  }
  text = stripInvisible(decodeEntities(text))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return truncate(text, RAW_ITEM_MAX_TEXT);
}

/** One post as a RawItem (kind post). */
export function postToItem(post: XPost, username: string | null): RawItem {
  const text = postText(post);
  const oneLine = text.replace(/\s+/g, " ").trim();
  const metrics = post.public_metrics ?? {};
  const published = post.created_at ? Date.parse(post.created_at) : NaN;
  const refs = references(post);
  const item: RawItem = {
    externalId: post.id,
    url: username ? `https://x.com/${username}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`,
    title: oneLine ? truncate(oneLine, 100) : username ? `Post by @${username}` : "Post on X",
    kind: "post",
    text,
    links: postLinks(post),
    meta: {
      likeCount: metrics.like_count ?? 0,
      repostCount: metrics.retweet_count ?? 0,
      replyCount: metrics.reply_count ?? 0,
      quoteCount: metrics.quote_count ?? 0,
      ...(metrics.impression_count !== undefined ? { impressionCount: metrics.impression_count } : {}),
      ...(post.lang ? { lang: post.lang } : {}),
      ...(refs.length > 0 ? { references: refs.map((ref) => ({ type: ref.type, id: ref.id })) } : {}),
      ...(post.note_tweet || post.note_post ? { longPost: true } : {}),
    },
  };
  if (username) item.author = `@${username}`;
  if (Number.isFinite(published)) item.publishedAt = published;
  return item;
}

/** Sorts items by post id, newest first. */
export function newestFirst(items: RawItem[]): RawItem[] {
  return [...items].sort((a, b) => compareIds(b.externalId, a.externalId));
}

// --- cost ----------------------------------------------------------------------------

/** Documented prices (docs.x.com pricing page, read on 2026-11-20). */
export const X_PRICE_PER_POST_USD = 0.005;
export const X_PRICE_PER_USER_USD = 0.01;

/** "$0.20" ("less than $0.01" for a small amount). */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "less than $0.01";
  return `$${amount.toFixed(2)}`;
}

/** Checks of one source each day for an interval in minutes (one decimal). */
export function runsPerDay(intervalMinutes: number): number {
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60;
  return Math.round((1440 / interval) * 10) / 10;
}

/** Throws kind budget when the daily post limit leaves fewer than `minimum` posts. Returns the remaining count. */
export function remainingPostsOrThrow(ctx: ConnectorContext, minimum: number): number {
  const remaining = ctx.usage.remaining("x_posts");
  if (remaining < minimum) {
    throw new ConnectorError(
      "budget",
      `The daily limit of X post reads is used (X_MAX_POSTS_PER_DAY). A request needs at least ${minimum} posts. The next check runs after midnight (UTC).`,
    );
  }
  return remaining;
}
