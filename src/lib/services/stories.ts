// The story reads of specification §4.1, §4.2, §8.1, §8.3 (§18.2 stories.ts).
//
// listFeedStories loads the small rank facts of every judgement of the
// window in one query, decides visibility and the score in code, sorts, and
// cuts to the limit. Only the stories that it returns get the full card
// (a fixed number of queries, see _read-cards.ts).
import { getSqlite } from "@/lib/db/client";
import { decayedScore, effectiveHalfLife, type RankWindow } from "@/lib/ranking";
import { DAY_MS, nowMs } from "@/lib/time";
import { HIDDEN_REASONS, ITEM_KINDS, SOURCE_TYPES, type HiddenReason, type ItemKind, type SourceType } from "@/lib/types";

import { buildCards, effectiveHidden, type CardSeed } from "./_read-cards";
import { asFeedbackReason, loadFeedFacts, parseIdList, readAnalysisView, type FeedFacts } from "./_read-shared";
import type { StoryDetail, StoryHidden, StoryItemRow, StoryList } from "./types";

const WINDOW_MS: Record<RankWindow, number> = { today: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS };
const DEFAULT_STORY_LIMIT = 50;
const MAX_STORY_LIMIT = 1000;
/** The story page shows the text of these kinds (short items). The others show '' (§4.2). */
const SHORT_KINDS: readonly ItemKind[] = ["post", "discussion", "thread", "search_result"];
const ITEM_TEXT_MAX = 2000;
/** The story page has no window control; its decay line uses the default window of the feed page. */
const STORY_PAGE_WINDOW: RankWindow = "week";

const EMPTY_LIST: StoryList = {
  stories: [],
  visibleCount: 0,
  filteredCount: 0,
  hasMore: false,
  pendingItems: 0,
  backfill: null,
  lastCheckAt: null,
};

type RankRow = {
  storyId: number;
  freshAt: number;
  baseScore: number;
  hiddenReason: string | null;
  topicIds: string;
  myVote: string | null;
};

type Ranked = CardSeed & { freshAt: number; score: number };

function asHiddenReason(value: string | null): HiddenReason | null {
  return value !== null && (HIDDEN_REASONS as readonly string[]).includes(value) ? (value as HiddenReason) : null;
}

function loadRankRows(feedId: number, userId: string, since: number): RankRow[] {
  return getSqlite()
    .prepare(
      `SELECT j.story_id AS storyId, s.fresh_at AS freshAt, j.base_score AS baseScore,
              j.hidden_reason AS hiddenReason, j.topic_ids AS topicIds, f.reason AS myVote
         FROM judgements j
         JOIN stories s ON s.id = j.story_id
         LEFT JOIN feedback f ON f.feed_id = j.feed_id AND f.story_id = j.story_id AND f.user_id = ?
        WHERE j.feed_id = ? AND s.fresh_at >= ?`,
    )
    .all(userId, feedId, since) as RankRow[];
}

/** The id of an active topic, or null when no active topic has the slug. */
function activeTopicId(slug: string): number | null {
  const row = getSqlite().prepare("SELECT id FROM topics WHERE slug = ? AND archived_at IS NULL").get(slug) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/** §8.3: "Top" by score, ties by fresh_at, then id; "Newest" by fresh_at, then id. All descending. */
function compareRanked(sort: "top" | "new"): (a: Ranked, b: Ranked) => number {
  return (a, b) => {
    if (sort === "top" && b.score !== a.score) return b.score - a.score;
    if (b.freshAt !== a.freshAt) return b.freshAt - a.freshAt;
    return b.storyId - a.storyId;
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_STORY_LIMIT;
  return Math.min(MAX_STORY_LIMIT, Math.max(1, Math.floor(limit)));
}

/** The queue facts of the empty states and the refresh rule of §4.1. */
function feedQueueFacts(feedId: number): Pick<StoryList, "pendingItems" | "backfill" | "lastCheckAt"> {
  const sqlite = getSqlite();
  const pending = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM items
        WHERE judge_status = 'pending' AND source_id IN (SELECT source_id FROM feed_sources WHERE feed_id = ?)`,
    )
    .get(feedId) as { n: number };
  const backfill = sqlite
    .prepare(
      `SELECT done, total, source_id AS sourceId FROM rejudge_requests
        WHERE feed_id = ? AND status IN ('queued', 'running')
        ORDER BY requested_at DESC, id DESC LIMIT 1`,
    )
    .get(feedId) as { done: number; total: number; sourceId: number | null } | undefined;
  const lastCheck = sqlite
    .prepare(
      `SELECT MAX(s.last_checked_at) AS at FROM sources s JOIN feed_sources fs ON fs.source_id = s.id WHERE fs.feed_id = ?`,
    )
    .get(feedId) as { at: number | null };
  return {
    pendingItems: pending.n,
    backfill: backfill
      ? { done: backfill.done, total: backfill.total, kind: backfill.sourceId === null ? "rejudge" : "backfill" }
      : null,
    lastCheckAt: lastCheck.at,
  };
}

/**
 * The ranked stories of one feed (§4.1). `visibleCount` and `filteredCount`
 * count the whole window (the topic filter does not change them).
 */
export async function listFeedStories(args: {
  feedId: number;
  window: "today" | "week" | "month";
  sort: "top" | "new";
  topicSlug?: string;
  filtered: boolean;
  userId: string;
  /** Default 50. */
  limit?: number;
  now?: number;
}): Promise<StoryList> {
  const feed = loadFeedFacts(args.feedId);
  if (!feed) return { ...EMPTY_LIST };
  const now = args.now ?? nowMs();
  const halfLife = effectiveHalfLife(feed.halfLifeHours, args.window);
  const rows = loadRankRows(feed.id, args.userId, now - WINDOW_MS[args.window]);

  let visibleCount = 0;
  let filteredCount = 0;
  const ranked: Ranked[] = [];
  const topicId = args.topicSlug ? activeTopicId(args.topicSlug) : null;
  for (const row of rows) {
    const myVote = asFeedbackReason(row.myVote);
    const hidden = effectiveHidden(asHiddenReason(row.hiddenReason), myVote);
    if (hidden === null) visibleCount += 1;
    else filteredCount += 1;
    if ((hidden !== null) !== args.filtered) continue;
    if (args.topicSlug && (topicId === null || !parseIdList(row.topicIds).includes(topicId))) continue;
    const { score } = decayedScore(row.baseScore, row.freshAt, halfLife, now);
    ranked.push({ storyId: row.storyId, hidden, myVote, freshAt: row.freshAt, score });
  }

  ranked.sort(compareRanked(args.sort));
  const limit = clampLimit(args.limit);
  const stories = buildCards(feed, ranked.slice(0, limit), { halfLifeHours: halfLife, now, fullSummary: false });
  return {
    stories,
    visibleCount,
    filteredCount,
    hasMore: ranked.length > limit,
    ...feedQueueFacts(feed.id),
  };
}

function storyItems(storyId: number): StoryItemRow[] {
  const rows = getSqlite()
    .prepare(
      `SELECT i.id, i.source_id AS sourceId, so.name AS sourceName, so.type AS sourceType, i.title, i.url, i.author,
              i.published_at AS publishedAt, i.kind, i.content_text AS text
         FROM items i JOIN sources so ON so.id = i.source_id
        WHERE i.story_id = ?
        ORDER BY COALESCE(i.published_at, i.fetched_at) ASC, i.id ASC`,
    )
    .all(storyId) as Array<Omit<StoryItemRow, "sourceType" | "kind"> & { sourceType: string; kind: string }>;
  return rows.map((row) => {
    const kind = (ITEM_KINDS as readonly string[]).includes(row.kind) ? (row.kind as ItemKind) : "article";
    return {
      ...row,
      sourceType: (SOURCE_TYPES as readonly string[]).includes(row.sourceType) ? (row.sourceType as SourceType) : "blog",
      kind,
      text: SHORT_KINDS.includes(kind) ? row.text.slice(0, ITEM_TEXT_MAX) : "",
    };
  });
}

/** The other active feeds where the story is visible now, in tab order. */
function otherFeeds(feedId: number, storyId: number): StoryDetail["otherFeeds"] {
  return getSqlite()
    .prepare(
      `SELECT f.slug, f.name FROM judgements j JOIN feeds f ON f.id = j.feed_id
        WHERE j.story_id = ? AND j.feed_id <> ? AND j.hidden_reason IS NULL AND f.archived_at IS NULL
        ORDER BY f.position ASC, f.id ASC`,
    )
    .all(storyId, feedId) as StoryDetail["otherFeeds"];
}

function storySeed(feed: FeedFacts, storyId: number, userId: string): CardSeed | null {
  const row = getSqlite()
    .prepare(
      `SELECT j.hidden_reason AS hiddenReason, f.reason AS myVote
         FROM judgements j
         LEFT JOIN feedback f ON f.feed_id = j.feed_id AND f.story_id = j.story_id AND f.user_id = ?
        WHERE j.feed_id = ? AND j.story_id = ?`,
    )
    .get(userId, feed.id, storyId) as { hiddenReason: string | null; myVote: string | null } | undefined;
  if (!row) return null;
  const myVote = asFeedbackReason(row.myVote);
  const hidden: StoryHidden | null = effectiveHidden(asHiddenReason(row.hiddenReason), myVote);
  return { storyId, hidden, myVote };
}

/**
 * The story page of one feed (§4.2). The card has the full summary and is
 * returned also when the story is hidden. Null when the feed has no
 * judgement for the story.
 */
export async function getStory(feedId: number, storyId: number, userId: string): Promise<StoryDetail | null> {
  const feed = loadFeedFacts(feedId);
  if (!feed) return null;
  const seed = storySeed(feed, storyId, userId);
  if (!seed) return null;
  const now = nowMs();
  const [card] = buildCards(feed, [seed], {
    halfLifeHours: effectiveHalfLife(feed.halfLifeHours, STORY_PAGE_WINDOW),
    now,
    fullSummary: true,
  });
  if (!card) return null;
  return {
    card,
    items: storyItems(storyId),
    otherFeeds: otherFeeds(feed.id, storyId),
    analysis: readAnalysisView(feed, storyId),
  };
}
