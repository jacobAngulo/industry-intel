// Builds StoryCards for a set of stories of one feed with a fixed number of
// queries (not one query for each story): the judgement and story facts, the
// sources, the alerts, the votes, and the active topics.
import { getSqlite } from "@/lib/db/client";
import { decayedScore } from "@/lib/ranking";
import { votesForStories } from "@/lib/ranking/recompute";
import { HOUR_MS } from "@/lib/time";
import {
  DEPTHS,
  NOVELTIES,
  SOURCE_TYPES,
  STORY_CATEGORIES,
  SUMMARY_SENTENCES,
  WORK_STATUSES,
  emptyVotes,
  type Depth,
  type FeedbackReason,
  type HiddenReason,
  type Novelty,
  type RankPart,
  type SourceType,
  type StoryCategory,
  type WorkStatus,
} from "@/lib/types";

import { parseIdList, parseJson, parseStringList, type FeedFacts } from "./_read-shared";
import type { StoryCard, StoryHidden } from "./types";

/** §9.3: the UI shows an alert for at most 72 h after it became visible. */
export const ALERT_SHOW_MS = 72 * HOUR_MS;

/** The view-level hide of §8.1: the browser's own negative vote. */
const SELF_HIDING_VOTES: readonly FeedbackReason[] = ["off_topic", "too_basic"];

/** The hidden reason that this browser sees: the stored one, else its own negative vote. */
export function effectiveHidden(stored: HiddenReason | null, myVote: FeedbackReason | null): StoryHidden | null {
  if (stored !== null) return stored;
  return myVote !== null && SELF_HIDING_VOTES.includes(myVote) ? "my_vote" : null;
}

/** One story to show, with what the caller already knows. */
export interface CardSeed {
  storyId: number;
  hidden: StoryHidden | null;
  myVote: FeedbackReason | null;
}

type CardRow = {
  storyId: number;
  relevance: number;
  reason: string;
  whyItMatters: string;
  suggestedAction: string | null;
  topicIds: string;
  exclusion: string | null;
  novelty: string;
  depth: string;
  baseScore: number;
  rankParts: string;
  headline: string;
  summary: string;
  category: string;
  primaryUrl: string | null;
  itemCount: number;
  sourceCount: number;
  freshAt: number;
  basis: unknown;
  analysisStatus: string | null;
};

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function loadCardRows(feedId: number, idsJson: string): Map<number, CardRow> {
  const rows = getSqlite()
    .prepare(
      `SELECT j.story_id AS storyId, j.relevance, j.reason, j.why_it_matters AS whyItMatters,
              j.suggested_action AS suggestedAction, j.topic_ids AS topicIds, j.exclusion, j.novelty, j.depth,
              j.base_score AS baseScore, j.rank_parts AS rankParts,
              s.headline, s.summary, s.category, s.primary_url AS primaryUrl, s.item_count AS itemCount,
              s.source_count AS sourceCount, s.fresh_at AS freshAt,
              json_extract(pi.meta, '$.basis') AS basis,
              a.status AS analysisStatus
         FROM judgements j
         JOIN stories s ON s.id = j.story_id
         LEFT JOIN items pi ON pi.id = s.primary_item_id
         LEFT JOIN analyses a ON a.feed_id = j.feed_id AND a.story_id = j.story_id
        WHERE j.feed_id = ? AND j.story_id IN (SELECT value FROM json_each(?))`,
    )
    .all(feedId, idsJson) as CardRow[];
  return new Map(rows.map((row) => [row.storyId, row]));
}

/**
 * The distinct sources of each story's items: the sources of this feed
 * first, then the others; inside each group the source of the oldest item first.
 */
function loadSources(feedId: number, idsJson: string): Map<number, StoryCard["sources"]> {
  const rows = getSqlite()
    .prepare(
      `SELECT i.story_id AS storyId, so.id, so.name, so.type,
              MAX(fs.source_id IS NOT NULL) AS inFeed, MIN(COALESCE(i.published_at, i.fetched_at)) AS firstAt
         FROM items i
         JOIN sources so ON so.id = i.source_id
         LEFT JOIN feed_sources fs ON fs.feed_id = ? AND fs.source_id = so.id
        WHERE i.story_id IN (SELECT value FROM json_each(?))
        GROUP BY i.story_id, so.id
        ORDER BY i.story_id, inFeed DESC, firstAt ASC, so.id ASC`,
    )
    .all(feedId, idsJson) as Array<{ storyId: number; id: number; name: string; type: string }>;
  const result = new Map<number, StoryCard["sources"]>();
  for (const row of rows) {
    let list = result.get(row.storyId);
    if (!list) result.set(row.storyId, (list = []));
    list.push({ id: row.id, name: row.name, type: oneOf<SourceType>(SOURCE_TYPES, row.type, "blog") });
  }
  return result;
}

/** The alerts that §9.3 lets the UI show now (the visibility of the judgement is checked later). */
function loadShownAlerts(feed: FeedFacts, idsJson: string, now: number): Map<number, number> {
  if (!feed.alerts.enabled) return new Map();
  const rows = getSqlite()
    .prepare(
      `SELECT id, story_id AS storyId FROM alerts
        WHERE feed_id = ? AND story_id IN (SELECT value FROM json_each(?)) AND visible_at <= ? AND visible_at >= ?`,
    )
    .all(feed.id, idsJson, now, now - ALERT_SHOW_MS) as Array<{ id: number; storyId: number }>;
  return new Map(rows.map((row) => [row.storyId, row.id]));
}

function loadActiveTopics(): Map<number, { id: number; slug: string; name: string }> {
  const rows = getSqlite().prepare("SELECT id, slug, name FROM topics WHERE archived_at IS NULL").all() as Array<{
    id: number;
    slug: string;
    name: string;
  }>;
  return new Map(rows.map((row) => [row.id, row]));
}

function parseRankParts(text: string): RankPart[] {
  const value = parseJson(text);
  return Array.isArray(value) ? (value as RankPart[]) : [];
}

function basisOf(value: unknown): StoryCard["basis"] {
  return value === "transcript" || value === "show_notes" ? value : null;
}

function analysisStatusOf(value: string | null): StoryCard["analysisStatus"] {
  return value !== null && (WORK_STATUSES as readonly string[]).includes(value) ? (value as WorkStatus) : "none";
}

/**
 * The cards of the given stories, in the given order. A seed whose story has
 * no judgement in the feed is left out. `fullSummary` keeps every sentence
 * (the story page); else the summary is cut to the summary length of the feed.
 */
export function buildCards(
  feed: FeedFacts,
  seeds: readonly CardSeed[],
  opts: { halfLifeHours: number; now: number; fullSummary: boolean },
): StoryCard[] {
  if (seeds.length === 0) return [];
  const ids = seeds.map((seed) => seed.storyId);
  const idsJson = JSON.stringify(ids);
  const rows = loadCardRows(feed.id, idsJson);
  const sources = loadSources(feed.id, idsJson);
  const alerts = loadShownAlerts(feed, idsJson, opts.now);
  const votes = votesForStories(feed.id, ids);
  const topics = loadActiveTopics();
  const sentences = SUMMARY_SENTENCES[feed.brief.summaryLength];

  const cards: StoryCard[] = [];
  for (const seed of seeds) {
    const row = rows.get(seed.storyId);
    if (!row) continue;
    const summary = parseStringList(row.summary);
    const decay = decayedScore(row.baseScore, row.freshAt, opts.halfLifeHours, opts.now);
    const alertId = alerts.get(seed.storyId);
    cards.push({
      storyId: seed.storyId,
      headline: row.headline,
      primaryUrl: row.primaryUrl,
      summary: opts.fullSummary ? summary : summary.slice(0, sentences),
      category: oneOf<StoryCategory>(STORY_CATEGORIES, row.category, "other"),
      basis: basisOf(row.basis),
      topics: parseIdList(row.topicIds).flatMap((id) => {
        const topic = topics.get(id);
        return topic ? [{ id: topic.id, slug: topic.slug, name: topic.name }] : [];
      }),
      sources: sources.get(seed.storyId) ?? [],
      itemCount: row.itemCount,
      sourceCount: row.sourceCount,
      freshAt: row.freshAt,
      whyItMatters: row.whyItMatters,
      suggestedAction: feed.brief.suggestedActions ? row.suggestedAction : null,
      relevance: row.relevance,
      reason: row.reason,
      novelty: oneOf<Novelty>(NOVELTIES, row.novelty, "new"),
      depth: oneOf<Depth>(DEPTHS, row.depth, "intermediate"),
      baseScore: row.baseScore,
      score: decay.score,
      decay: { ageHours: decay.ageHours, halfLifeHours: opts.halfLifeHours, factor: decay.factor },
      rankParts: parseRankParts(row.rankParts),
      hidden: seed.hidden,
      exclusion: row.exclusion,
      alert: alertId !== undefined && seed.hidden === null ? { id: alertId } : null,
      votes: votes.get(seed.storyId) ?? emptyVotes(),
      myVote: seed.myVote,
      analysisStatus: analysisStatusOf(row.analysisStatus),
    });
  }
  return cards;
}
