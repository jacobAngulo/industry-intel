// The query of the feed page (specification §3): window, sort, topic,
// show=filtered, limit. Pure functions: a bad value falls back to the default.

export const FEED_WINDOWS = ["today", "week", "month"] as const;
export type FeedWindow = (typeof FEED_WINDOWS)[number];
export const FEED_SORTS = ["top", "new"] as const;
export type FeedSort = (typeof FEED_SORTS)[number];

export const WINDOW_LABELS: Record<FeedWindow, string> = { today: "Today", week: "7 days", month: "30 days" };
export const SORT_LABELS: Record<FeedSort, string> = { top: "Top", new: "Newest" };

export const DEFAULT_WINDOW: FeedWindow = "week";
export const DEFAULT_SORT: FeedSort = "top";
export const DEFAULT_LIMIT = 50;
/** "Show more" adds this many stories. */
export const LIMIT_STEP = 50;
export const MAX_LIMIT = 1000;

export interface FeedQuery {
  window: FeedWindow;
  sort: FeedSort;
  /** A topic slug, or null for all topics. */
  topic: string | null;
  /** True for `show=filtered` (the stories that are not visible). */
  filtered: boolean;
  limit: number;
}

export const DEFAULT_FEED_QUERY: FeedQuery = {
  window: DEFAULT_WINDOW,
  sort: DEFAULT_SORT,
  topic: null,
  filtered: false,
  limit: DEFAULT_LIMIT,
};

export type SearchParamsLike = Record<string, string | string[] | undefined>;

/** The first value of a query parameter. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function oneOf<T extends string>(list: readonly T[], value: string | undefined, fallback: T): T {
  return value !== undefined && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A topic slug (slugify: letters of any script, digits, and dashes). */
const TOPIC_SLUG = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]{0,79}$/u;

/** The page query. Unknown or bad values give the defaults. */
export function parseFeedQuery(params: SearchParamsLike): FeedQuery {
  const topicRaw = first(params.topic)?.trim().toLowerCase();
  const limitRaw = first(params.limit)?.trim();
  let limit = DEFAULT_LIMIT;
  if (limitRaw && /^\d{1,6}$/.test(limitRaw)) {
    const n = Number(limitRaw);
    if (n >= 1) limit = Math.min(MAX_LIMIT, n);
  }
  return {
    window: oneOf(FEED_WINDOWS, first(params.window), DEFAULT_WINDOW),
    sort: oneOf(FEED_SORTS, first(params.sort), DEFAULT_SORT),
    topic: topicRaw && TOPIC_SLUG.test(topicRaw) ? topicRaw : null,
    filtered: first(params.show) === "filtered",
    limit,
  };
}

/**
 * The address of the feed page with `change` applied. Default values stay out
 * of the address. A change of the window, sort, topic, or view starts again at
 * the default limit.
 */
export function feedHref(slug: string, current: FeedQuery, change: Partial<FeedQuery> = {}): string {
  const resetsLimit =
    ("window" in change && change.window !== current.window) ||
    ("sort" in change && change.sort !== current.sort) ||
    ("topic" in change && change.topic !== current.topic) ||
    ("filtered" in change && change.filtered !== current.filtered);
  const next: FeedQuery = { ...current, ...(resetsLimit && !("limit" in change) ? { limit: DEFAULT_LIMIT } : {}), ...change };
  const params = new URLSearchParams();
  if (next.window !== DEFAULT_WINDOW) params.set("window", next.window);
  if (next.sort !== DEFAULT_SORT) params.set("sort", next.sort);
  if (next.topic) params.set("topic", next.topic);
  if (next.filtered) params.set("show", "filtered");
  if (next.limit !== DEFAULT_LIMIT) params.set("limit", String(next.limit));
  const query = params.toString();
  const base = `/f/${encodeURIComponent(slug)}`;
  return query ? `${base}?${query}` : base;
}

/** The wider window to offer when a window has no story (null for the widest). */
export function widerWindow(window: FeedWindow): FeedWindow | null {
  if (window === "today") return "week";
  if (window === "week") return "month";
  return null;
}
