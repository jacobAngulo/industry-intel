// The re-judge worker step (§7.6): one story of one request for each call.
import { getSqlite } from "@/lib/db/client";
import type { RejudgeRequestDbRow } from "@/lib/db/schema";
import { recomputeJudgements } from "@/lib/ranking/recompute";

import { rejudgeWorkStoryIds, type RejudgeScope } from "./jobs";
import { activeTopicIds, judgeMaxTokens, promptItemOf, promptStoryOf } from "./judge";
import { insertJudgement, readJudgement, replaceJudgement } from "./judgements";
import { asLlmError, noteModelSuccess, notePauseFor } from "./model-errors";
import { loadFeedPromptInfo, readTeamProfile, storedSourceFilter } from "./prompt-data";
import { judgeSystemPrompt, judgeUserPrompt } from "./prompts";
import { readItem, readSource } from "./rows";
import { cleanJudgeOutput, judgeSingleStorySchemaFor, type JudgeSingleStoryRaw } from "./schemas";
import type { PipelineDeps } from "./types";

/** A story that fails this many times is counted as failed and skipped. */
export const REJUDGE_STORY_MAX_FAILURES = 2;

/**
 * Item errors of each story, for each request id. In memory on purpose: after
 * a restart of the worker the failed stories can be tried again (the work
 * list in the database still has them, because their judged_at is old).
 */
const failures = new Map<number, Map<number, number>>();

/** Tests: forget the failures, as a restart of the worker does. */
export function forgetRejudgeFailures(): void {
  failures.clear();
}

function excludedStories(requestId: number): number[] {
  const counts = failures.get(requestId);
  if (!counts) return [];
  return [...counts].filter(([, n]) => n >= REJUDGE_STORY_MAX_FAILURES).map(([storyId]) => storyId);
}

function scopeOf(request: RejudgeRequestDbRow): RejudgeScope {
  return { feedId: request.feedId, sourceId: request.sourceId, sinceAt: request.sinceAt, requestedAt: request.requestedAt };
}

function capLeft(request: RejudgeRequestDbRow): number {
  const used = request.done + request.failed;
  return request.maxStories === null ? Number.POSITIVE_INFINITY : Math.max(0, request.maxStories - used);
}

/** Sets an open request to done. A request that is not open any more stays as it is. */
function finish(requestId: number, now: number): void {
  getSqlite()
    .prepare(
      `UPDATE rejudge_requests SET status = 'done', finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(now, now, requestId);
  failures.delete(requestId);
}

const REQUEST_COLUMNS = `id, feed_id AS feedId, source_id AS sourceId, since_at AS sinceAt, max_stories AS maxStories, status,
  total, done, failed, requested_by AS requestedBy, requested_at AS requestedAt, started_at AS startedAt,
  updated_at AS updatedAt, finished_at AS finishedAt`;

/**
 * The full request row: the oldest open request, or the request with this id.
 * Call it inside the transaction that uses the row: the web process can extend
 * an open request at any time (new requested_at, since_at, max_stories, total).
 */
function readRequest(id?: number): RejudgeRequestDbRow | undefined {
  const sqlite = getSqlite();
  if (id === undefined) {
    return sqlite
      .prepare(`SELECT ${REQUEST_COLUMNS} FROM rejudge_requests WHERE status IN ('queued', 'running') ORDER BY id LIMIT 1`)
      .get() as RejudgeRequestDbRow | undefined;
  }
  return sqlite.prepare(`SELECT ${REQUEST_COLUMNS} FROM rejudge_requests WHERE id = ?`).get(id) as RejudgeRequestDbRow | undefined;
}

/** Counts one failure of a story; at the limit, failed + 1 (the story is then skipped). */
function countStoryFailure(requestId: number, storyId: number, now: number, final: boolean): void {
  const counts = failures.get(requestId) ?? new Map<number, number>();
  failures.set(requestId, counts);
  const n = final ? REJUDGE_STORY_MAX_FAILURES : (counts.get(storyId) ?? 0) + 1;
  counts.set(storyId, n);
  const sqlite = getSqlite();
  if (n >= REJUDGE_STORY_MAX_FAILURES) {
    sqlite.prepare("UPDATE rejudge_requests SET failed = failed + 1, updated_at = ? WHERE id = ?").run(now, requestId);
  } else {
    sqlite.prepare("UPDATE rejudge_requests SET updated_at = ? WHERE id = ?").run(now, requestId);
  }
}

type Step =
  | { kind: "none" }
  | { kind: "finished" }
  | { kind: "work"; request: RejudgeRequestDbRow; storyId: number; itemId: number | null };

/** Takes the oldest open request, starts it, and picks its next story. One IMMEDIATE transaction. */
function nextStep(now: number): Step {
  const sqlite = getSqlite();
  return sqlite
    .transaction((): Step => {
      let request = readRequest();
      if (!request) return { kind: "none" };

      const feed = sqlite.prepare("SELECT archived_at AS archivedAt FROM feeds WHERE id = ?").get(request.feedId) as
        | { archivedAt: number | null }
        | undefined;
      const excluded = excludedStories(request.id);
      const scope = scopeOf(request);

      if (request.status === "queued") {
        const work = rejudgeWorkStoryIds(scope, 5000, excluded).length;
        const total = request.done + request.failed + Math.min(work, capLeft(request));
        sqlite
          .prepare(
            `UPDATE rejudge_requests SET status = 'running', started_at = COALESCE(started_at, @now), total = @total,
                    updated_at = @now WHERE id = @id`,
          )
          .run({ id: request.id, now, total });
        request = { ...request, status: "running", total };
      }

      const [storyId] = capLeft(request) > 0 && feed?.archivedAt === null ? rejudgeWorkStoryIds(scope, 1, excluded) : [];
      if (storyId === undefined) {
        finish(request.id, now);
        return { kind: "finished" };
      }

      // The longest item of the story from a source that is in the feed now.
      const item = sqlite
        .prepare(
          `SELECT i.id FROM items i JOIN feed_sources fs ON fs.source_id = i.source_id AND fs.feed_id = ?
            WHERE i.story_id = ? ORDER BY LENGTH(i.content_text) DESC, i.id LIMIT 1`,
        )
        .get(request.feedId, storyId) as { id: number } | undefined;
      return { kind: "work", request, storyId, itemId: item?.id ?? null };
    })
    .immediate();
}

/**
 * Writes the new judgement (always a replace; created_at stays), the rank, and
 * the progress. The scope, the cap, and the "more" test use the row as it is
 * now, not the row from before the model call.
 */
function applyRejudge(request: RejudgeRequestDbRow, storyId: number, itemId: number, data: JudgeSingleStoryRaw, model: string, now: number): void {
  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      const fresh = readRequest(request.id);
      const [result] = cleanJudgeOutput(data, { feedIds: [request.feedId], topicIds: activeTopicIds() }).feeds;
      if (!fresh || !result) return;
      const old = readJudgement(request.feedId, storyId);
      if (old) replaceJudgement(old.id, result, itemId, model, now);
      else insertJudgement(storyId, result, itemId, model, now);
      recomputeJudgements({ feedId: request.feedId, storyIds: [storyId] });
      sqlite.prepare("UPDATE rejudge_requests SET done = done + 1, updated_at = ? WHERE id = ?").run(now, request.id);

      if (fresh.status !== "queued" && fresh.status !== "running") return;
      const after = { ...fresh, done: fresh.done + 1 };
      const more = capLeft(after) > 0 && rejudgeWorkStoryIds(scopeOf(fresh), 1, excludedStories(fresh.id)).length > 0;
      if (!more) finish(fresh.id, now);
    })
    .immediate();
}

/** One story of one request (§7.6). True when it did work. Re-judge never creates alerts. */
export async function runRejudgeStep(deps: PipelineDeps): Promise<boolean> {
  const step = nextStep(deps.now());
  if (step.kind === "none") return false;
  if (step.kind === "finished") return true;

  const { request, storyId } = step;
  const item = step.itemId === null ? null : readItem(step.itemId);
  const source = item ? readSource(item.sourceId) : null;
  const story = promptStoryOf(storyId);
  if (!item || !source || !story) {
    countStoryFailure(request.id, storyId, deps.now(), true);
    return true;
  }

  const start = deps.now();
  const feeds = loadFeedPromptInfo([request.feedId], storedSourceFilter(source.id), start);
  try {
    const reply = await deps.llm.json<JudgeSingleStoryRaw>({
      task: "judge",
      schema: judgeSingleStorySchemaFor([request.feedId]),
      system: judgeSystemPrompt("single"),
      user: judgeUserPrompt({ now: start, team: readTeamProfile(), feeds, item: promptItemOf(item, source), story }),
      maxOutputTokens: judgeMaxTokens("single", 1),
    });
    const now = deps.now();
    noteModelSuccess(now);
    applyRejudge(request, storyId, item.id, reply.data, reply.model, now);
  } catch (thrown) {
    const error = asLlmError(thrown);
    const now = deps.now();
    // A service error pauses the model and is not a failure of the story.
    if (notePauseFor(error, now) === "item") countStoryFailure(request.id, storyId, now, false);
  }
  return true;
}
