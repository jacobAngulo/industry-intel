// The judge call (§7.3) for one claimed item, and the draft judge of the
// add-source preview. judgeItem never throws for model errors.
import type { RawItem } from "@/lib/connectors/types";
import { getSqlite } from "@/lib/db/client";
import type { ItemDbRow, SourceDbRow } from "@/lib/db/schema";
import { hiddenReason } from "@/lib/ranking";
import { MINUTE_MS } from "@/lib/time";
import { emptyVotes, type Priority, type SourceType } from "@/lib/types";

import { applyJudgeResult } from "./apply";
import { silentJoin, findLinkJoin } from "./links";
import { asLlmError, noteModelSuccess, notePauseFor } from "./model-errors";
import {
  candidateMatchText,
  candidateStories,
  loadFeedPromptInfo,
  readTeamProfile,
  storedSourceFilter,
  type FeedPromptInfo,
  type SourceFilter,
} from "./prompt-data";
import { judgeSystemPrompt, judgeUserPrompt, type PromptItem, type PromptStory } from "./prompts";
import { activeFeedIdsForSource, feedsNeedingJudgement, readItem, readSource, readStory } from "./rows";
import { cleanJudgeOutput, judgeNormalSchemaFor, judgeSingleStorySchemaFor, type CleanJudgeOutput } from "./schemas";
import type { DraftJudgement, JudgeOutcome, PipelineDeps } from "./types";

/** After this many item errors the item is `failed`. */
export const MAX_JUDGE_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60 * MINUTE_MS;

/** Output tokens: the item facts plus about 450 tokens for each feed result. */
export function judgeMaxTokens(mode: "normal" | "single", feedCount: number): number {
  return (mode === "normal" ? 700 : 200) + 450 * Math.max(1, feedCount);
}

export function activeTopicIds(): number[] {
  const rows = getSqlite().prepare("SELECT id FROM topics WHERE archived_at IS NULL").all() as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function metaText(meta: Record<string, unknown> | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function promptItemOf(item: ItemDbRow, source: Pick<SourceDbRow, "name" | "type">): PromptItem {
  return {
    sourceName: source.name,
    sourceType: source.type,
    kind: item.kind,
    title: item.title,
    author: item.author,
    publishedAt: item.publishedAt,
    url: item.url,
    basis: metaText(item.meta, "basis"),
    undated: item.meta.undated === true,
    text: item.contentText,
  };
}

export function promptStoryOf(storyId: number): PromptStory | null {
  const story = readStory(storyId);
  return story ? { id: story.id, headline: story.headline, summary: story.summary, firstSeenAt: story.firstSeenAt } : null;
}

type Plan =
  | { kind: "done"; outcome: JudgeOutcome }
  | { kind: "normal"; feedIds: number[]; linkedStoryId: number | null }
  | { kind: "single"; feedIds: number[]; storyId: number };

function markJudged(itemId: number, now: number): void {
  getSqlite()
    .prepare(
      `UPDATE items SET judge_status = 'judged', judged_at = ?, judge_locked_until = NULL, next_judge_at = NULL
        WHERE id = ?`,
    )
    .run(now, itemId);
}

/** "Before the call" (§7.3): the link join again, then the mode. One IMMEDIATE transaction. */
function planCall(itemId: number, now: number): Plan {
  const sqlite = getSqlite();
  return sqlite
    .transaction((): Plan => {
      let item = readItem(itemId);
      if (!item || item.judgeStatus !== "pending") return { kind: "done", outcome: "skipped" };
      let joined = false;
      let linkedStoryId: number | null = null;
      if (item.storyId === null) {
        const link = findLinkJoin(itemId, now);
        if (link && !link.lowSubstance) {
          silentJoin(itemId, link.storyId, now);
          joined = true;
          item = readItem(itemId) ?? item;
        } else if (link) {
          linkedStoryId = link.storyId;
        }
      }

      if (item.storyId !== null) {
        const feedIds = feedsNeedingJudgement(item.storyId, item.sourceId);
        if (feedIds.length > 0) return { kind: "single", feedIds, storyId: item.storyId };
        markJudged(itemId, now);
        return { kind: "done", outcome: joined ? "joined" : "judged" };
      }

      const feedIds = activeFeedIdsForSource(item.sourceId);
      if (feedIds.length > 0) return { kind: "normal", feedIds, linkedStoryId };
      sqlite
        .prepare(`UPDATE items SET judge_status = 'skipped', skip_reason = 'no_feed', judge_locked_until = NULL WHERE id = ?`)
        .run(itemId);
      return { kind: "done", outcome: "skipped" };
    })
    .immediate();
}

/**
 * An item error (§7.3): attempts + 1, the error, and the next try after
 * 2^attempts minutes (at most 60); after 5 attempts the item is `failed`.
 */
export function recordJudgeItemError(itemId: number, message: string, now: number): "retry" | "failed" {
  const sqlite = getSqlite();
  return sqlite
    .transaction((): "retry" | "failed" => {
      const item = readItem(itemId);
      if (!item) return "failed";
      const attempts = item.judgeAttempts + 1;
      const failed = attempts >= MAX_JUDGE_ATTEMPTS;
      sqlite
        .prepare(
          `UPDATE items SET judge_attempts = @attempts, judge_error = @message, judge_locked_until = NULL,
                  judge_status = CASE WHEN @failed = 1 THEN 'failed' ELSE judge_status END,
                  next_judge_at = CASE WHEN @failed = 1 THEN NULL ELSE @next END
            WHERE id = @id`,
        )
        .run({
          id: itemId,
          attempts,
          message: message.slice(0, 300),
          failed: failed ? 1 : 0,
          next: now + Math.min(2 ** attempts * MINUTE_MS, MAX_RETRY_DELAY_MS),
        });
      return failed ? "failed" : "retry";
    })
    .immediate();
}

function unlock(itemId: number): void {
  getSqlite().prepare("UPDATE items SET judge_locked_until = NULL WHERE id = ?").run(itemId);
}

/** The judge call and the apply step for one claimed item (§7.3, §7.4). Never throws for model errors. */
export async function judgeItem(itemId: number, deps: PipelineDeps): Promise<{ outcome: JudgeOutcome }> {
  const start = deps.now();
  const plan = planCall(itemId, start);
  if (plan.kind === "done") return { outcome: plan.outcome };

  const item = readItem(itemId);
  const source = item ? readSource(item.sourceId) : null;
  if (!item || !source) return { outcome: "skipped" };

  const feeds = loadFeedPromptInfo(plan.feedIds, storedSourceFilter(source.id), start);
  const promptItem = promptItemOf(item, source);
  const matchText = candidateMatchText(item.title, item.contentText);
  const candidates = plan.kind === "normal" ? candidateStories(matchText, plan.linkedStoryId, start) : [];
  const story = plan.kind === "single" ? promptStoryOf(plan.storyId) : null;
  if (plan.kind === "single" && !story) {
    unlock(itemId);
    return { outcome: "skipped" };
  }
  const feedIds = feeds.map((feed) => feed.id);
  const mode = plan.kind;

  let output: CleanJudgeOutput;
  let model: string;
  try {
    const reply = await deps.llm.json<unknown>({
      task: "judge",
      schema: mode === "normal" ? judgeNormalSchemaFor(feedIds) : judgeSingleStorySchemaFor(feedIds),
      system: judgeSystemPrompt(mode),
      user: judgeUserPrompt({
        now: start,
        team: readTeamProfile(),
        feeds,
        item: promptItem,
        ...(story ? { story } : { candidates }),
      }),
      maxOutputTokens: judgeMaxTokens(mode, feedIds.length),
    });
    output = cleanJudgeOutput(reply.data as Parameters<typeof cleanJudgeOutput>[0], {
      feedIds,
      topicIds: activeTopicIds(),
      candidateStoryIds: candidates.map((candidate) => candidate.id),
    });
    model = reply.model;
  } catch (thrown) {
    const error = asLlmError(thrown);
    const now = deps.now();
    if (notePauseFor(error, now) === "service") {
      unlock(itemId);
      return { outcome: "paused" };
    }
    return { outcome: recordJudgeItemError(itemId, error.message, now) };
  }

  const now = deps.now();
  noteModelSuccess(now);
  const outcome = applyJudgeResult({ itemId, mode, callStartedAt: start, output, matchText, model, now });
  return { outcome };
}

/** Judge an item that is not in the database, for the preview. No write except usage (metric llm_calls_preview). */
export async function judgeDraft(args: {
  item: RawItem;
  source: { name: string; type: SourceType };
  feeds: Array<{ feedId: number; follow: string; ignore: string; priority: Priority }>;
  deps: PipelineDeps;
}): Promise<DraftJudgement[]> {
  const now = args.deps.now();
  const filters = new Map<number, SourceFilter>();
  for (const feed of args.feeds) filters.set(feed.feedId, { follow: feed.follow, ignore: feed.ignore, priority: feed.priority });
  const feeds = loadFeedPromptInfo([...filters.keys()], (feedId) => filters.get(feedId) as SourceFilter, now);
  if (feeds.length === 0) return [];
  const feedIds = feeds.map((feed) => feed.id);

  const item: PromptItem = {
    sourceName: args.source.name,
    sourceType: args.source.type,
    kind: args.item.kind,
    title: args.item.title,
    author: args.item.author ?? null,
    publishedAt: args.item.publishedAt ?? null,
    url: args.item.url ?? null,
    basis: metaText(args.item.meta, "basis"),
    undated: args.item.meta?.undated === true,
    text: args.item.text,
  };

  let data: unknown;
  try {
    const reply = await args.deps.llm.json<unknown>({
      task: "judge",
      schema: judgeNormalSchemaFor(feedIds),
      system: judgeSystemPrompt("normal"),
      user: judgeUserPrompt({ now, team: readTeamProfile(), feeds, item, candidates: [] }),
      usageMetric: "llm_calls_preview",
      maxOutputTokens: judgeMaxTokens("normal", feedIds.length),
    });
    data = reply.data;
  } catch (thrown) {
    throw asLlmError(thrown);
  }

  const output = cleanJudgeOutput(data as Parameters<typeof cleanJudgeOutput>[0], { feedIds, topicIds: activeTopicIds() });
  const byId = new Map(feeds.map((feed) => [feed.id, feed]));
  return output.feeds.map((result) => {
    const feed = byId.get(result.feedId) as FeedPromptInfo;
    const topics = feed.topics.filter((topic) => result.topicIds.includes(topic.id));
    return {
      feedId: result.feedId,
      relevance: result.relevance,
      reason: result.reason,
      whyItMatters: result.whyItMatters,
      hiddenReason: hiddenReason({
        relevance: result.relevance,
        exclusion: result.exclusion,
        substance: output.item?.substance ?? "news",
        topicPriorities: topics.map((topic) => topic.priority),
        topicNames: topics.map((topic) => topic.name),
        signals: result.signals,
        priorities: feed.priorities,
        sourcePriority: feed.sourcePriority,
        sourceQuality: null,
        sourceCount: 1,
        novelty: result.novelty,
        depth: result.depth,
        feedDepth: feed.depth,
        votes: emptyVotes(),
        minRelevance: feed.minRelevance,
      }),
    };
  });
}
