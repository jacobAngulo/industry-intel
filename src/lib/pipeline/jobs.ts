// Shared job helpers (specification §5, §7.3, §7.6, §7.7, §13).
//
// The web process (the services) and the worker (the pipeline) both call
// these functions, so that the two processes use one definition of each rule:
// - the worker state rows (heartbeat, model pause),
// - the model gate (is a model call allowed now?),
// - the re-judge work list and the re-judge requests,
// - the backfill when a feed starts to use a source,
// - the refresh of story counts after items are deleted.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb, getSqlite } from "@/lib/db/client";
import { deleteStoryFts } from "@/lib/db/fts";
import { rejudgeRequests, type RejudgeRequestDbRow } from "@/lib/db/schema";
import { getEnv, hasModelKey, type Env } from "@/lib/env";
import { recomputeJudgements } from "@/lib/ranking/recompute";
import { DAY_MS, SECOND_MS, nextUtcMidnight, nowMs } from "@/lib/time";
import type { WorkerHeartbeat } from "@/lib/types";
import { createUsageMeter } from "@/lib/usage";

// ---------------------------------------------------------------------------
// Worker state (table worker_state)
// ---------------------------------------------------------------------------

export const WORKER_STATE_KEYS = {
  heartbeat: "heartbeat",
  lease: "worker_lease",
  llmPausedUntil: "llm_paused_until",
  llmPauseStep: "llm_pause_step",
  llmLastError: "llm_last_error",
} as const;

/** The heartbeat counts as alive when it is younger than this (§4.10, §13). */
export const HEARTBEAT_ALIVE_MS = 30 * SECOND_MS;

/** Reads one worker_state value. Null when the row is absent or its JSON is bad. */
export function readWorkerState<T>(key: string): T | null {
  const row = getSqlite().prepare("SELECT value FROM worker_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** Writes (or replaces) one worker_state value. */
export function writeWorkerState(key: string, value: unknown, now: number = nowMs()): void {
  getSqlite()
    .prepare(
      `INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), now);
}

/** Deletes one worker_state row. No row is not an error. */
export function deleteWorkerState(key: string): void {
  getSqlite().prepare("DELETE FROM worker_state WHERE key = ?").run(key);
}

/** The newest heartbeat of the worker, or null when the worker never ran. */
export function readHeartbeat(): WorkerHeartbeat | null {
  const beat = readWorkerState<WorkerHeartbeat>(WORKER_STATE_KEYS.heartbeat);
  return beat && typeof beat.at === "number" ? beat : null;
}

/** True when the heartbeat is younger than HEARTBEAT_ALIVE_MS. */
export function isWorkerAlive(now: number = nowMs(), beat: WorkerHeartbeat | null = readHeartbeat()): boolean {
  return beat !== null && now - beat.at < HEARTBEAT_ALIVE_MS;
}

// ---------------------------------------------------------------------------
// Model pause and model gate (§7.3)
// ---------------------------------------------------------------------------

export interface LlmPauseState {
  /** Epoch ms. Null when no pause was set. A value in the past means "no pause now". */
  pausedUntil: number | null;
  /** The doubling step of the pause (§7.3). 0 after a successful call. */
  step: number;
  /** A short reason in plain words, fit to show in the UI. Null after a successful call. */
  lastError: string | null;
}

export function readLlmPause(): LlmPauseState {
  const until = readWorkerState<number>(WORKER_STATE_KEYS.llmPausedUntil);
  const step = readWorkerState<number>(WORKER_STATE_KEYS.llmPauseStep);
  const lastError = readWorkerState<string>(WORKER_STATE_KEYS.llmLastError);
  return {
    pausedUntil: typeof until === "number" ? until : null,
    step: typeof step === "number" && step >= 0 ? step : 0,
    lastError: typeof lastError === "string" && lastError ? lastError : null,
  };
}

/** Stores a model pause. The caller computes `until` and `step` (§7.3 failure handling). */
export function setLlmPause(input: { until: number; step: number; lastError: string }, now: number = nowMs()): void {
  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      writeWorkerState(WORKER_STATE_KEYS.llmPausedUntil, input.until, now);
      writeWorkerState(WORKER_STATE_KEYS.llmPauseStep, Math.max(0, Math.floor(input.step)), now);
      writeWorkerState(WORKER_STATE_KEYS.llmLastError, input.lastError.slice(0, 300), now);
    })
    .immediate();
}

/** After a successful model call: no pause, step 0, no last error. */
export function clearLlmPause(now: number = nowMs()): void {
  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      deleteWorkerState(WORKER_STATE_KEYS.llmPausedUntil);
      writeWorkerState(WORKER_STATE_KEYS.llmPauseStep, 0, now);
      deleteWorkerState(WORKER_STATE_KEYS.llmLastError);
    })
    .immediate();
}

export interface ModelGate {
  open: boolean;
  reason?: "no_key" | "paused" | "budget";
  /** For `paused` and `budget`: the time when model calls can start again. */
  until?: number;
}

/**
 * Is a model call allowed now? Closed when the key is missing, when the model
 * is paused, or when the daily call limit is used (§7.3). The web process
 * passes its own environment (it makes the preview calls itself).
 */
export function modelGate(now: number = nowMs(), env: Env = getEnv()): ModelGate {
  if (!hasModelKey(env)) return { open: false, reason: "no_key" };
  const pause = readLlmPause();
  if (pause.pausedUntil !== null && pause.pausedUntil > now) {
    return { open: false, reason: "paused", until: pause.pausedUntil };
  }
  if (createUsageMeter(env).remaining("llm_calls") <= 0) {
    return { open: false, reason: "budget", until: nextUtcMidnight(now) };
  }
  return { open: true };
}

// ---------------------------------------------------------------------------
// Re-judge (§7.6)
// ---------------------------------------------------------------------------

/** The default period of a re-judge request: the last 7 days. */
export const REJUDGE_DEFAULT_SINCE_MS = 7 * DAY_MS;
/** §7.7: a feed that starts to use a source gets at most this many items back in the queue. */
export const BACKFILL_MAX_ITEMS = 8;
/** §7.7: and at most this many stories re-judged. */
export const BACKFILL_MAX_STORIES = 8;

export interface RejudgeScope {
  feedId: number;
  /** Null = all sources of the feed. */
  sourceId: number | null;
  /** Items fetched at or after this time are in the period. */
  sinceAt: number;
  /** A judgement made before this time counts as "to do". */
  requestedAt: number;
}

/**
 * The work list of a re-judge request (§7.6): the stories that have an item
 * (fetched in the period) from a source of the feed (or from the one source),
 * whose judgement in the feed was made before `requestedAt`, or that have no
 * judgement in the feed. Newest item first.
 *
 * The list shrinks while the work runs, because each re-judged story gets a
 * newer `judged_at`. So a restart continues and never repeats a call.
 * `excludeStoryIds` lets the worker skip stories that failed too often.
 */
export function rejudgeWorkStoryIds(scope: RejudgeScope, limit = 1000, excludeStoryIds: readonly number[] = []): number[] {
  const rows = getSqlite()
    .prepare(
      `SELECT s.id AS id, MAX(i.fetched_at) AS last_fetch
         FROM stories s
         JOIN items i ON i.story_id = s.id
         JOIN feed_sources fs ON fs.source_id = i.source_id AND fs.feed_id = @feedId
         LEFT JOIN judgements j ON j.story_id = s.id AND j.feed_id = @feedId
        WHERE i.fetched_at >= @sinceAt
          AND (@sourceId IS NULL OR i.source_id = @sourceId)
          AND (j.id IS NULL OR j.judged_at < @requestedAt)
          AND s.id NOT IN (SELECT value FROM json_each(@exclude))
        GROUP BY s.id
        ORDER BY last_fetch DESC, s.id DESC
        LIMIT @limit`,
    )
    .all({
      feedId: scope.feedId,
      sourceId: scope.sourceId,
      sinceAt: scope.sinceAt,
      requestedAt: scope.requestedAt,
      exclude: JSON.stringify(excludeStoryIds),
      limit: Math.max(0, Math.floor(limit)),
    }) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * The number of model calls that a new re-judge request would make now
 * (one for each story of the work list, cut to `maxStories`).
 */
export function estimateRejudgeCount(
  feedId: number,
  opts: { sourceId?: number | null; sinceMs?: number; maxStories?: number | null; now?: number } = {},
): number {
  const now = opts.now ?? nowMs();
  const cap = opts.maxStories ?? null;
  const list = rejudgeWorkStoryIds(
    {
      feedId,
      sourceId: opts.sourceId ?? null,
      sinceAt: now - (opts.sinceMs ?? REJUDGE_DEFAULT_SINCE_MS),
      requestedAt: now,
    },
    cap === null ? 5000 : Math.max(0, cap),
  );
  return list.length;
}

function remainingCap(maxStories: number | null, used: number): number {
  return maxStories === null ? Number.POSITIVE_INFINITY : Math.max(0, maxStories - used);
}

/**
 * Creates a re-judge request, or returns the open one (queued or running) of
 * the same feed and source (§7.6). An open request gets the new request time,
 * so the stories that were judged before this call are in its work list
 * again. A request with no work is stored as `done` at once.
 */
export function createRejudgeRequest(input: {
  feedId: number;
  sourceId?: number | null;
  sinceMs?: number;
  maxStories?: number | null;
  requestedBy: string;
  now?: number;
}): { request: RejudgeRequestDbRow; created: boolean } {
  const now = input.now ?? nowMs();
  const sourceId = input.sourceId ?? null;
  const sinceAt = now - (input.sinceMs ?? REJUDGE_DEFAULT_SINCE_MS);
  const maxStories = input.maxStories ?? null;
  const db = getDb();

  return getSqlite()
    .transaction(() => {
      const open = db
        .select()
        .from(rejudgeRequests)
        .where(
          and(
            eq(rejudgeRequests.feedId, input.feedId),
            sourceId === null ? isNull(rejudgeRequests.sourceId) : eq(rejudgeRequests.sourceId, sourceId),
            inArray(rejudgeRequests.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(rejudgeRequests.requestedAt))
        .get();

      if (open) {
        const mergedSince = Math.min(open.sinceAt, sinceAt);
        const mergedMax =
          open.maxStories === null || maxStories === null ? null : Math.max(open.maxStories, maxStories);
        const used = open.done + open.failed;
        const work = rejudgeWorkStoryIds(
          { feedId: input.feedId, sourceId, sinceAt: mergedSince, requestedAt: now },
          5000,
        ).length;
        const total = used + Math.min(work, remainingCap(mergedMax, used));
        const request = db
          .update(rejudgeRequests)
          .set({ sinceAt: mergedSince, maxStories: mergedMax, requestedAt: now, updatedAt: now, total })
          .where(eq(rejudgeRequests.id, open.id))
          .returning()
          .get();
        return { request, created: false };
      }

      const work = rejudgeWorkStoryIds({ feedId: input.feedId, sourceId, sinceAt, requestedAt: now }, 5000).length;
      const total = Math.min(work, remainingCap(maxStories, 0));
      const request = db
        .insert(rejudgeRequests)
        .values({
          feedId: input.feedId,
          sourceId,
          sinceAt,
          maxStories,
          status: total === 0 ? "done" : "queued",
          total,
          done: 0,
          failed: 0,
          requestedBy: input.requestedBy,
          requestedAt: now,
          updatedAt: now,
          finishedAt: total === 0 ? now : null,
        })
        .returning()
        .get();
      return { request, created: true };
    })
    .immediate();
}

/** The newest re-judge request of a feed (any status), or null. */
export function latestRejudgeRequest(feedId: number): RejudgeRequestDbRow | null {
  return (
    getDb()
      .select()
      .from(rejudgeRequests)
      .where(eq(rejudgeRequests.feedId, feedId))
      .orderBy(desc(rejudgeRequests.requestedAt), desc(rejudgeRequests.id))
      .get() ?? null
  );
}

// ---------------------------------------------------------------------------
// Backfill when a feed starts to use a source (§7.7)
// ---------------------------------------------------------------------------

/**
 * Call this in the same transaction that adds the feed_sources row (it nests
 * as a savepoint). It (a) puts the newest `no_feed` items of the source from
 * the last 7 days back in the judge queue, and (b) queues a re-judge request
 * for the recent stories of the source in this feed. Nothing happens for an
 * archived feed.
 */
export function backfillFeedSource(input: {
  feedId: number;
  sourceId: number;
  requestedBy: string;
  now?: number;
}): { queuedItems: number; queuedStories: number; requestId: number | null } {
  const now = input.now ?? nowMs();
  const sqlite = getSqlite();
  return sqlite
    .transaction(() => {
      const feed = sqlite.prepare("SELECT archived_at FROM feeds WHERE id = ?").get(input.feedId) as
        | { archived_at: number | null }
        | undefined;
      if (!feed || feed.archived_at !== null) return { queuedItems: 0, queuedStories: 0, requestId: null };

      const requeued = sqlite
        .prepare(
          `UPDATE items
              SET judge_status = 'pending', skip_reason = NULL, judge_attempts = 0, judge_error = NULL,
                  next_judge_at = NULL, judge_locked_until = NULL
            WHERE id IN (
              SELECT id FROM items
               WHERE source_id = @sourceId AND judge_status = 'skipped' AND skip_reason = 'no_feed'
                 AND fetched_at >= @sinceAt
               ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
               LIMIT @limit)`,
        )
        .run({ sourceId: input.sourceId, sinceAt: now - REJUDGE_DEFAULT_SINCE_MS, limit: BACKFILL_MAX_ITEMS });

      const stories = estimateRejudgeCount(input.feedId, {
        sourceId: input.sourceId,
        maxStories: BACKFILL_MAX_STORIES,
        now,
      });
      let requestId: number | null = null;
      if (stories > 0) {
        requestId = createRejudgeRequest({
          feedId: input.feedId,
          sourceId: input.sourceId,
          maxStories: BACKFILL_MAX_STORIES,
          requestedBy: input.requestedBy,
          now,
        }).request.id;
      }
      return { queuedItems: requeued.changes, queuedStories: stories, requestId };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// Story counts after items are deleted (§5 "Deleting a source", §7.1 step 7)
// ---------------------------------------------------------------------------

/** The ids of the stories that have no item. */
export function orphanStoryIds(): number[] {
  const rows = getSqlite()
    .prepare("SELECT s.id AS id FROM stories s WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.story_id = s.id)")
    .all() as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * Recomputes item_count, source_count, last_item_at, and the primary item of
 * each story (the oldest item that stays, when the old primary item is gone).
 * Deletes the stories with no item and their search rows (their judgements,
 * votes, analyses, and alerts go by cascade). Then recomputes the rank of the
 * stories that stay. Safe inside a transaction of the caller.
 */
export function refreshStories(storyIds: readonly number[], now: number = nowMs()): { updated: number[]; deleted: number[] } {
  const ids = [...new Set(storyIds)];
  if (ids.length === 0) return { updated: [], deleted: [] };
  const sqlite = getSqlite();
  const aggregate = sqlite.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT source_id) AS sources,
            MAX(MIN(@now, COALESCE(published_at, fetched_at))) AS last
       FROM items WHERE story_id = @storyId`,
  );
  const primaryOf = sqlite.prepare(
    `SELECT s.primary_item_id AS primaryItemId,
            (SELECT 1 FROM items i WHERE i.id = s.primary_item_id AND i.story_id = s.id) AS primaryOk
       FROM stories s WHERE s.id = ?`,
  );
  const oldestItem = sqlite.prepare(
    `SELECT id, url FROM items WHERE story_id = ? ORDER BY COALESCE(published_at, fetched_at) ASC, id ASC LIMIT 1`,
  );
  const deleteStory = sqlite.prepare("DELETE FROM stories WHERE id = ?");
  const updateCounts = sqlite.prepare(
    `UPDATE stories SET item_count = @n, source_count = @sources, last_item_at = @last, updated_at = @now WHERE id = @id`,
  );
  const updatePrimary = sqlite.prepare("UPDATE stories SET primary_item_id = ?, primary_url = ? WHERE id = ?");

  return sqlite
    .transaction(() => {
      const updated: number[] = [];
      const deleted: number[] = [];
      for (const id of ids) {
        const story = primaryOf.get(id) as { primaryItemId: number | null; primaryOk: number | null } | undefined;
        if (!story) continue;
        const agg = aggregate.get({ now, storyId: id }) as { n: number; sources: number; last: number | null };
        if (agg.n === 0) {
          deleteStory.run(id);
          deleteStoryFts(id);
          deleted.push(id);
          continue;
        }
        updateCounts.run({ id, n: agg.n, sources: agg.sources, last: agg.last ?? now, now });
        if (story.primaryItemId === null || story.primaryOk !== 1) {
          const oldest = oldestItem.get(id) as { id: number; url: string | null } | undefined;
          if (oldest) updatePrimary.run(oldest.id, oldest.url, id);
        }
        updated.push(id);
      }
      if (updated.length > 0) recomputeJudgements({ storyIds: updated });
      return { updated, deleted };
    })
    .immediate();
}
