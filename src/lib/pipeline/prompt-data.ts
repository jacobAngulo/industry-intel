// The data that the judge prompt needs (§7.3): the shared feed profile, the feeds
// with their settings and feedback hints, and the candidate stories.
import { getSqlite } from "@/lib/db/client";
import { buildMatchText, searchStories } from "@/lib/db/fts";
import { effectiveBriefFormatOf } from "@/lib/ranking/recompute";
import { significantWords } from "@/lib/text";
import { DAY_MS } from "@/lib/time";
import {
  DEFAULT_RELEVANCE_PRIORITIES,
  EMPTY_TEAM_PROFILE,
  FEEDBACK_REASONS,
  type AlertSettings,
  type FeedbackReason,
  type Priority,
  type RelevancePriorities,
  type TeamProfile,
  type TechnicalDepth,
  type TopicPriority,
} from "@/lib/types";

import { parseJsonText } from "./rows";

export const CANDIDATE_WINDOW_MS = 10 * DAY_MS;
export const CANDIDATE_SEARCH_LIMIT = 5;
const CALIBRATION_WINDOW_MS = 30 * DAY_MS;
const CALIBRATION_PER_REASON = 5;
const CALIBRATION_PER_CLIENT = 2;
const MATCH_WORDS = 12;

export interface PromptTopic {
  id: number;
  name: string;
  description: string;
  priority: TopicPriority;
}

/** The Follow / Ignore text and the priority of one source in one feed. */
export interface SourceFilter {
  follow: string;
  ignore: string;
  priority: Priority;
}

export interface FeedPromptInfo {
  id: number;
  name: string;
  purpose: string;
  projectContext: string;
  topics: PromptTopic[];
  exclusions: string[];
  priorities: RelevancePriorities;
  follow: string;
  ignore: string;
  sourcePriority: Priority;
  /** The alert rule when alerts are on and the rule is not empty, else null. */
  alertRule: string | null;
  depth: TechnicalDepth;
  minRelevance: number;
  /** Headlines that the team voted on, for each reason (§7.3 feedback calibration). */
  calibration: Record<FeedbackReason, string[]>;
}

export interface CandidateStory {
  id: number;
  headline: string;
  firstSentence: string;
  date: number;
  /** True for the story that a link join found (a certain candidate). */
  linked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readTeamProfile(): TeamProfile {
  const row = getSqlite().prepare("SELECT value FROM settings WHERE key = 'team_profile'").get() as
    | { value: string }
    | undefined;
  const value = row ? parseJsonText(row.value) : null;
  if (!isRecord(value)) return { ...EMPTY_TEAM_PROFILE };
  return {
    whatWeDo: text(value.whatWeDo),
    constraints: text(value.constraints),
  };
}

/** The active topics with the priority of each in this feed (no row = normal). */
function feedTopics(feedId: number): PromptTopic[] {
  return getSqlite()
    .prepare(
      `SELECT t.id AS id, t.name AS name, t.description AS description, COALESCE(ft.priority, 'normal') AS priority
         FROM topics t LEFT JOIN feed_topics ft ON ft.topic_id = t.id AND ft.feed_id = ?
        WHERE t.archived_at IS NULL ORDER BY t.id`,
    )
    .all(feedId) as PromptTopic[];
}

/**
 * Up to 5 recent headlines for each feedback reason (last 30 days). A headline
 * counts under a reason only when that reason has more votes than "useful"
 * on the story ("useful": more than the other reasons together). At most 2 of
 * the headlines of a reason come from one browser.
 */
export function feedbackCalibration(feedId: number, now: number): Record<FeedbackReason, string[]> {
  const sqlite = getSqlite();
  const votes = sqlite
    .prepare(
      `SELECT f.story_id AS storyId, f.reason AS reason, f.user_id AS userId, s.headline AS headline
         FROM feedback f JOIN stories s ON s.id = f.story_id
        WHERE f.feed_id = ? AND f.created_at >= ?
        ORDER BY f.created_at DESC, f.id DESC`,
    )
    .all(feedId, now - CALIBRATION_WINDOW_MS) as Array<{ storyId: number; reason: FeedbackReason; userId: string; headline: string }>;

  const counts = new Map<number, Record<string, number>>();
  const countRows = sqlite
    .prepare(
      `SELECT story_id AS storyId, reason, COUNT(*) AS n FROM feedback
        WHERE feed_id = ? AND story_id IN (SELECT value FROM json_each(?)) GROUP BY story_id, reason`,
    )
    .all(feedId, JSON.stringify([...new Set(votes.map((vote) => vote.storyId))])) as Array<{ storyId: number; reason: string; n: number }>;
  for (const row of countRows) {
    const story = counts.get(row.storyId) ?? {};
    story[row.reason] = row.n;
    counts.set(row.storyId, story);
  }

  const qualifies = (storyId: number, reason: FeedbackReason): boolean => {
    const story = counts.get(storyId) ?? {};
    const useful = story.useful ?? 0;
    if (reason === "useful") {
      return useful > (story.too_basic ?? 0) + (story.off_topic ?? 0) + (story.already_knew ?? 0);
    }
    return (story[reason] ?? 0) > useful;
  };

  const result = Object.fromEntries(FEEDBACK_REASONS.map((reason) => [reason, [] as string[]])) as Record<FeedbackReason, string[]>;
  for (const reason of FEEDBACK_REASONS) {
    const listed = new Set<number>();
    const perUser = new Map<string, number>();
    for (const vote of votes) {
      if (result[reason].length >= CALIBRATION_PER_REASON) break;
      if (vote.reason !== reason || listed.has(vote.storyId) || !qualifies(vote.storyId, reason)) continue;
      const used = perUser.get(vote.userId) ?? 0;
      if (used >= CALIBRATION_PER_CLIENT) continue;
      perUser.set(vote.userId, used + 1);
      listed.add(vote.storyId);
      result[reason].push(vote.headline);
    }
  }
  return result;
}

type FeedRow = {
  id: number;
  name: string;
  purpose: string;
  project_context: string;
  min_relevance: number;
  exclusions: string;
  relevance_priorities: string;
  brief_format: string;
  alerts: string;
};

function parsePriorities(value: unknown): RelevancePriorities {
  return isRecord(value) ? { ...DEFAULT_RELEVANCE_PRIORITIES, ...(value as Partial<RelevancePriorities>) } : { ...DEFAULT_RELEVANCE_PRIORITIES };
}

function parseAlertRule(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const alerts = value as Partial<AlertSettings>;
  const rule = text(alerts.rule);
  return alerts.enabled === true && rule !== "" ? rule : null;
}

/**
 * The prompt facts of the given feeds (active or not; the caller chooses the
 * feeds), in the order of the ids. `filterOf` gives the Follow / Ignore text
 * and the priority of the source in each feed.
 */
export function loadFeedPromptInfo(
  feedIds: readonly number[],
  filterOf: (feedId: number) => SourceFilter,
  now: number,
): FeedPromptInfo[] {
  const select = getSqlite().prepare(
    `SELECT id, name, purpose, project_context, min_relevance, exclusions, relevance_priorities, brief_format, alerts
       FROM feeds WHERE id = ?`,
  );
  const out: FeedPromptInfo[] = [];
  for (const feedId of feedIds) {
    const row = select.get(feedId) as FeedRow | undefined;
    if (!row) continue;
    const exclusions = parseJsonText(row.exclusions);
    const filter = filterOf(feedId);
    out.push({
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      projectContext: row.project_context,
      topics: feedTopics(row.id),
      exclusions: Array.isArray(exclusions) ? exclusions.filter((entry): entry is string => typeof entry === "string") : [],
      priorities: parsePriorities(parseJsonText(row.relevance_priorities)),
      follow: filter.follow.trim(),
      ignore: filter.ignore.trim(),
      sourcePriority: filter.priority,
      alertRule: parseAlertRule(parseJsonText(row.alerts)),
      depth: effectiveBriefFormatOf(row.brief_format).technicalDepth,
      minRelevance: row.min_relevance,
      calibration: feedbackCalibration(row.id, now),
    });
  }
  return out;
}

/** The Follow / Ignore text and priority of a source in a feed, from feed_sources. */
export function storedSourceFilter(sourceId: number): (feedId: number) => SourceFilter {
  const select = getSqlite().prepare("SELECT follow, ignore, priority FROM feed_sources WHERE feed_id = ? AND source_id = ?");
  return (feedId) => {
    const row = select.get(feedId, sourceId) as SourceFilter | undefined;
    return row ?? { follow: "", ignore: "", priority: "normal" };
  };
}

/**
 * The MATCH text of the candidate search: at most 12 significant words of the
 * title, plus words of the first 200 characters of the text when the title
 * has fewer than 4 significant words.
 */
export function candidateMatchText(title: string, body: string): string {
  let words = significantWords(title);
  if (words.length < 4) words = [...new Set([...words, ...significantWords(body.slice(0, 200))])];
  return buildMatchText(words.slice(0, MATCH_WORDS));
}

/** The ids of the stories that the candidate search returns now (best match first). */
export function searchCandidateIds(matchText: string, now: number): number[] {
  return searchStories(matchText, now - CANDIDATE_WINDOW_MS, CANDIDATE_SEARCH_LIMIT).map((row) => row.id);
}

/** The candidate stories of a normal-mode call: the link-matched story first, then the search results. */
export function candidateStories(matchText: string, linkedStoryId: number | null, now: number): CandidateStory[] {
  const ids = searchCandidateIds(matchText, now).filter((id) => id !== linkedStoryId);
  if (linkedStoryId !== null) ids.unshift(linkedStoryId);
  const select = getSqlite().prepare("SELECT id, headline, summary, first_seen_at AS date FROM stories WHERE id = ?");
  const out: CandidateStory[] = [];
  for (const id of ids) {
    const row = select.get(id) as { id: number; headline: string; summary: string; date: number } | undefined;
    if (!row) continue;
    const summary = parseJsonText(row.summary);
    const first = Array.isArray(summary) && typeof summary[0] === "string" ? summary[0] : "";
    out.push({ id: row.id, headline: row.headline, firstSentence: first, date: row.date, linked: id === linkedStoryId });
  }
  return out;
}
