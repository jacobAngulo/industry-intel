// The database helper of specification §8 / §8.4: it reads what the rank
// formula needs and writes base_score, rank_parts, and hidden_reason.
// The pipeline and the services call it. It is safe inside a transaction of
// the caller (better-sqlite3 turns a nested transaction into a savepoint).
//
// Each feed's data (the feed row, its topic priorities, the source quality
// map) loads one time; the judgements of the feed then load in one query.
import { getSqlite } from "@/lib/db/client";
import { nowMs, DAY_MS } from "@/lib/time";
import {
  DEFAULT_BRIEF_FORMAT,
  DEFAULT_RELEVANCE_PRIORITIES,
  DEPTHS,
  FEEDBACK_REASONS,
  NOVELTIES,
  PRIORITIES,
  RELEVANCE_WEIGHTS,
  SUBSTANCES,
  SUMMARY_LENGTHS,
  TECHNICAL_DEPTHS,
  TOPIC_PRIORITIES,
  emptyVotes,
  type BriefFormat,
  type BriefFormatOverride,
  type FeedbackReason,
  type Priority,
  type RelevancePriorities,
  type Signals,
  type TechnicalDepth,
  type TopicPriority,
} from "@/lib/types";

import { baseScore, hiddenReason, sourceQualityScore, type RankInput, type SourceQualityInput } from "./index";

/** Q looks at the votes of the last 90 days (§8.2). */
export const SOURCE_QUALITY_WINDOW_MS = 90 * DAY_MS;

// --- small parsers for JSON columns ---------------------------------------------

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parsePriorities(text: unknown): RelevancePriorities {
  const value = parseJson(text);
  if (!isRecord(value)) return { ...DEFAULT_RELEVANCE_PRIORITIES };
  return {
    practical: oneOf(RELEVANCE_WEIGHTS, value.practical, DEFAULT_RELEVANCE_PRIORITIES.practical),
    experiment: oneOf(RELEVANCE_WEIGHTS, value.experiment, DEFAULT_RELEVANCE_PRIORITIES.experiment),
    other: typeof value.other === "string" ? value.other : "",
  };
}

function parseSignals(text: unknown): Signals {
  const value = parseJson(text);
  if (!isRecord(value)) return { practical: 0, experiment: 0 };
  return {
    practical: asNumber(value.practical),
    experiment: asNumber(value.experiment),
  };
}

function parseIdList(text: unknown): number[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => Number.isInteger(id)))];
}

function parseBriefOverride(text: unknown): BriefFormatOverride {
  const value = parseJson(text);
  if (!isRecord(value)) return { summaryLength: null, technicalDepth: null, suggestedActions: null };
  return {
    summaryLength: (SUMMARY_LENGTHS as readonly unknown[]).includes(value.summaryLength)
      ? (value.summaryLength as BriefFormatOverride["summaryLength"])
      : null,
    technicalDepth: (TECHNICAL_DEPTHS as readonly unknown[]).includes(value.technicalDepth)
      ? (value.technicalDepth as TechnicalDepth)
      : null,
    suggestedActions: typeof value.suggestedActions === "boolean" ? value.suggestedActions : null,
  };
}

// --- shared reads ----------------------------------------------------------------

/**
 * The shared brief defaults (settings key `brief_defaults`). A missing or
 * broken field takes the built-in default of §9.1.
 */
export function readBriefDefaults(): BriefFormat {
  const row = getSqlite().prepare("SELECT value FROM settings WHERE key = 'brief_defaults'").get() as
    | { value: string }
    | undefined;
  const value = row ? parseJson(row.value) : null;
  if (!isRecord(value)) return { ...DEFAULT_BRIEF_FORMAT };
  return {
    summaryLength: oneOf(SUMMARY_LENGTHS, value.summaryLength, DEFAULT_BRIEF_FORMAT.summaryLength),
    technicalDepth: oneOf(TECHNICAL_DEPTHS, value.technicalDepth, DEFAULT_BRIEF_FORMAT.technicalDepth),
    suggestedActions:
      typeof value.suggestedActions === "boolean" ? value.suggestedActions : DEFAULT_BRIEF_FORMAT.suggestedActions,
  };
}

/** The effective brief format of a feed: the feed value, or the shared default when null (§9.1). */
export function effectiveBriefFormatOf(briefFormatJson: unknown, defaults: BriefFormat = readBriefDefaults()): BriefFormat {
  const override = parseBriefOverride(briefFormatJson);
  return {
    summaryLength: override.summaryLength ?? defaults.summaryLength,
    technicalDepth: override.technicalDepth ?? defaults.technicalDepth,
    suggestedActions: override.suggestedActions ?? defaults.suggestedActions,
  };
}

/**
 * The votes on each story in one feed. Every requested story id has an
 * entry (zero counts when it has no vote).
 */
export function votesForStories(feedId: number, storyIds: number[]): Map<number, Record<FeedbackReason, number>> {
  const result = new Map<number, Record<FeedbackReason, number>>();
  const ids = [...new Set(storyIds.filter((id) => Number.isInteger(id)))];
  for (const id of ids) result.set(id, emptyVotes());
  if (ids.length === 0) return result;
  const rows = getSqlite()
    .prepare(
      `SELECT story_id AS storyId, reason, COUNT(*) AS n FROM feedback
       WHERE feed_id = ? AND story_id IN (SELECT value FROM json_each(?))
       GROUP BY story_id, reason`,
    )
    .all(feedId, JSON.stringify(ids)) as Array<{ storyId: number; reason: string; n: number }>;
  for (const row of rows) {
    const votes = result.get(row.storyId);
    if (votes && (FEEDBACK_REASONS as readonly string[]).includes(row.reason)) {
      votes[row.reason as FeedbackReason] = row.n;
    }
  }
  return result;
}

/** All votes on the stories of one feed (for a recompute of the whole feed). */
function votesForFeed(feedId: number): Map<number, Record<FeedbackReason, number>> {
  const result = new Map<number, Record<FeedbackReason, number>>();
  const rows = getSqlite()
    .prepare(`SELECT story_id AS storyId, reason, COUNT(*) AS n FROM feedback WHERE feed_id = ? GROUP BY story_id, reason`)
    .all(feedId) as Array<{ storyId: number; reason: string; n: number }>;
  for (const row of rows) {
    if (!(FEEDBACK_REASONS as readonly string[]).includes(row.reason)) continue;
    let votes = result.get(row.storyId);
    if (!votes) result.set(row.storyId, (votes = emptyVotes()));
    votes[row.reason as FeedbackReason] = row.n;
  }
  return result;
}

/**
 * The input of the term Q for each source (§8.2): the votes of the last 90
 * days in this feed on stories that have an item of that source. A source
 * with no such vote has no entry. A vote counts one time for each source
 * that has an item in the voted story.
 */
export function sourceQualityForFeed(feedId: number, now: number = nowMs()): Map<number, SourceQualityInput> {
  const rows = getSqlite()
    .prepare(
      `SELECT s.source_id AS sourceId, f.reason AS reason, COUNT(*) AS n
       FROM feedback f
       JOIN (SELECT DISTINCT source_id, story_id FROM items WHERE story_id IS NOT NULL) s ON s.story_id = f.story_id
       WHERE f.feed_id = ? AND f.created_at >= ?
       GROUP BY s.source_id, f.reason`,
    )
    .all(feedId, now - SOURCE_QUALITY_WINDOW_MS) as Array<{ sourceId: number; reason: string; n: number }>;
  const result = new Map<number, SourceQualityInput>();
  for (const row of rows) {
    let quality = result.get(row.sourceId);
    if (!quality) result.set(row.sourceId, (quality = { useful: 0, offTopic: 0, tooBasic: 0 }));
    if (row.reason === "useful") quality.useful += row.n;
    else if (row.reason === "off_topic") quality.offTopic += row.n;
    else if (row.reason === "too_basic") quality.tooBasic += row.n;
  }
  return result;
}

// --- the recompute ---------------------------------------------------------------

type FeedRow = { id: number; minRelevance: number; relevancePriorities: string; briefFormat: string };

type JudgementRow = {
  id: number;
  storyId: number;
  relevance: number;
  exclusion: string | null;
  topicIds: string;
  novelty: string;
  depth: string;
  signals: string;
  substance: string;
  sourceCount: number;
};

type FeedContext = {
  feedId: number;
  minRelevance: number;
  priorities: RelevancePriorities;
  feedDepth: TechnicalDepth;
  /** Active topics: id -> name. */
  topicNames: Map<number, string>;
  /** Rows of feed_topics: topic id -> priority (no row = normal). */
  topicPriorities: Map<number, TopicPriority>;
  quality: Map<number, SourceQualityInput>;
};

const PRIORITY_ORDER: Record<Priority, number> = { high: 2, normal: 1, low: 0 };

/** Builds the RankInput of one judgement. Exported for tests. */
export function rankInputOf(
  feed: FeedContext,
  row: JudgementRow,
  storySources: Array<{ sourceId: number; priority: Priority }>,
  votes: Record<FeedbackReason, number>,
): RankInput {
  const topicPriorities: TopicPriority[] = [];
  const topicNames: string[] = [];
  for (const topicId of parseIdList(row.topicIds)) {
    const name = feed.topicNames.get(topicId);
    if (name === undefined) continue; // archived or gone: ignored
    topicPriorities.push(feed.topicPriorities.get(topicId) ?? "normal");
    topicNames.push(name);
  }

  let sourcePriority: Priority | null = null;
  let bestQuality: SourceQualityInput | null = null;
  let bestQ = -Infinity;
  for (const source of storySources) {
    if (sourcePriority === null || PRIORITY_ORDER[source.priority] > PRIORITY_ORDER[sourcePriority]) {
      sourcePriority = source.priority;
    }
    const quality = feed.quality.get(source.sourceId) ?? null;
    const q = sourceQualityScore(quality);
    if (q > bestQ || (q === bestQ && bestQuality === null && quality !== null)) {
      bestQ = q;
      bestQuality = quality;
    }
  }

  return {
    relevance: row.relevance,
    exclusion: row.exclusion === null || row.exclusion.trim() === "" ? null : row.exclusion,
    substance: oneOf(SUBSTANCES, row.substance, "news"),
    topicPriorities,
    topicNames,
    signals: parseSignals(row.signals),
    priorities: feed.priorities,
    sourcePriority,
    sourceQuality: bestQuality,
    sourceCount: row.sourceCount,
    novelty: oneOf(NOVELTIES, row.novelty, "new"),
    depth: oneOf(DEPTHS, row.depth, "intermediate"),
    feedDepth: feed.feedDepth,
    votes,
    minRelevance: feed.minRelevance,
  };
}

function loadFeedContext(feed: FeedRow, activeTopics: Map<number, string>, defaults: BriefFormat, now: number): FeedContext {
  const sqlite = getSqlite();
  const topicPriorities = new Map<number, TopicPriority>();
  const rows = sqlite.prepare("SELECT topic_id AS topicId, priority FROM feed_topics WHERE feed_id = ?").all(feed.id) as Array<{
    topicId: number;
    priority: string;
  }>;
  for (const row of rows) topicPriorities.set(row.topicId, oneOf(TOPIC_PRIORITIES, row.priority, "normal"));
  return {
    feedId: feed.id,
    minRelevance: feed.minRelevance,
    priorities: parsePriorities(feed.relevancePriorities),
    feedDepth: effectiveBriefFormatOf(feed.briefFormat, defaults).technicalDepth,
    topicNames: activeTopics,
    topicPriorities,
    quality: sourceQualityForFeed(feed.id, now),
  };
}

/**
 * Recomputes base_score, rank_parts, and hidden_reason of the judgements
 * that match all the given arguments (no argument = every judgement):
 * - `feedId`: the judgements of one feed;
 * - `storyIds`: the judgements of these stories (in each feed);
 * - `sinceMs`: a duration: the judgements whose
 *   max(stories.fresh_at, judgements.created_at) >= now - sinceMs
 *   (for example 30 days for a rank-time setting, §8.4).
 * Returns the number of judgements that it wrote.
 */
export function recomputeJudgements(args: { feedId?: number; storyIds?: number[]; sinceMs?: number }): number {
  const sqlite = getSqlite();
  const now = nowMs();
  if (args.storyIds !== undefined && args.storyIds.length === 0) return 0;

  const where: string[] = [];
  const params: unknown[] = [];
  if (args.feedId !== undefined) {
    where.push("j.feed_id = ?");
    params.push(args.feedId);
  }
  if (args.storyIds !== undefined) {
    where.push("j.story_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify([...new Set(args.storyIds)]));
  }
  if (args.sinceMs !== undefined && Number.isFinite(args.sinceMs)) {
    where.push("MAX(s.fresh_at, j.created_at) >= ?");
    params.push(now - args.sinceMs);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const run = () => {
    const feedIds = (
      sqlite
        .prepare(`SELECT DISTINCT j.feed_id AS feedId FROM judgements j JOIN stories s ON s.id = j.story_id ${whereSql}`)
        .all(...params) as Array<{ feedId: number }>
    ).map((row) => row.feedId);
    if (feedIds.length === 0) return 0;

    const defaults = readBriefDefaults();
    const activeTopics = new Map<number, string>();
    for (const topic of sqlite.prepare("SELECT id, name FROM topics WHERE archived_at IS NULL").all() as Array<{
      id: number;
      name: string;
    }>) {
      activeTopics.set(topic.id, topic.name);
    }

    const selectFeed = sqlite.prepare(
      `SELECT id, min_relevance AS minRelevance, relevance_priorities AS relevancePriorities, brief_format AS briefFormat
       FROM feeds WHERE id = ?`,
    );
    const feedWhere = where.length > 0 ? `${whereSql} AND j.feed_id = ?` : "WHERE j.feed_id = ?";
    const selectJudgements = sqlite.prepare(
      `SELECT j.id, j.story_id AS storyId, j.relevance, j.exclusion, j.topic_ids AS topicIds, j.novelty, j.depth,
              j.signals, s.substance, s.source_count AS sourceCount
       FROM judgements j JOIN stories s ON s.id = j.story_id ${feedWhere}`,
    );
    const selectSources = sqlite.prepare(
      `SELECT DISTINCT j.story_id AS storyId, fs.source_id AS sourceId, fs.priority
       FROM judgements j
       JOIN stories s ON s.id = j.story_id
       JOIN items i ON i.story_id = j.story_id
       JOIN feed_sources fs ON fs.feed_id = j.feed_id AND fs.source_id = i.source_id
       ${feedWhere}`,
    );
    const update = sqlite.prepare("UPDATE judgements SET base_score = ?, rank_parts = ?, hidden_reason = ? WHERE id = ?");

    let written = 0;
    for (const feedId of feedIds) {
      const feed = selectFeed.get(feedId) as FeedRow | undefined;
      if (!feed) continue;
      const context = loadFeedContext(feed, activeTopics, defaults, now);
      const rows = selectJudgements.all(...params, feedId) as JudgementRow[];
      if (rows.length === 0) continue;

      const sourcesByStory = new Map<number, Array<{ sourceId: number; priority: Priority }>>();
      for (const row of selectSources.all(...params, feedId) as Array<{ storyId: number; sourceId: number; priority: string }>) {
        let list = sourcesByStory.get(row.storyId);
        if (!list) sourcesByStory.set(row.storyId, (list = []));
        list.push({ sourceId: row.sourceId, priority: oneOf(PRIORITIES, row.priority, "normal") });
      }
      const votes =
        args.storyIds !== undefined
          ? votesForStories(feedId, rows.map((row) => row.storyId))
          : votesForFeed(feedId);

      for (const row of rows) {
        const input = rankInputOf(context, row, sourcesByStory.get(row.storyId) ?? [], votes.get(row.storyId) ?? emptyVotes());
        const { base, parts } = baseScore(input);
        update.run(base, JSON.stringify(parts), hiddenReason(input), row.id);
        written += 1;
      }
    }
    return written;
  };

  // A savepoint inside a transaction of the caller; else one IMMEDIATE transaction.
  return sqlite.transaction(run).immediate();
}
