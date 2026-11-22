// Story feedback (specification §4.3, §8.4, §8.5; §18.2 feedback.ts).
// One vote for each person for each story in each feed.
import { getSqlite } from "@/lib/db/client";
import { recomputeJudgements, votesForStories } from "@/lib/ranking/recompute";
import { DAY_MS, nowMs } from "@/lib/time";
import { emptyVotes, type FeedbackReason } from "@/lib/types";
import { feedbackReasonSchema } from "@/lib/form-schemas";

import { ServiceError, asFeedbackReason, hasJudgement } from "./_read-shared";
import type { Actor } from "./types";

/** §8.4: a vote changes Q of its sources, so the feed's judgements of this period get a recompute. */
const VOTE_RECOMPUTE_MS = 14 * DAY_MS;

type VoteChange = "insert" | "replace" | "remove" | "none";

/** The toggle of §4.3: null or the same reason again removes; another reason replaces. */
function decideChange(current: FeedbackReason | null, wanted: FeedbackReason | null): VoteChange {
  if (wanted === null || wanted === current) return current === null ? "none" : "remove";
  return current === null ? "insert" : "replace";
}

/**
 * The stories of the feed from the last 14 days that have an item of a
 * source of the voted story (their term Q changed), plus the voted story.
 */
function storiesToRecompute(feedId: number, storyId: number, now: number): number[] {
  const rows = getSqlite()
    .prepare(
      `SELECT j.story_id AS id
         FROM judgements j JOIN stories s ON s.id = j.story_id
        WHERE j.feed_id = @feedId AND MAX(s.fresh_at, j.created_at) >= @since
          AND EXISTS (SELECT 1 FROM items i
                       WHERE i.story_id = j.story_id
                         AND i.source_id IN (SELECT source_id FROM items WHERE story_id = @storyId))`,
    )
    .all({ feedId, storyId, since: now - VOTE_RECOMPUTE_MS }) as Array<{ id: number }>;
  return [...new Set([storyId, ...rows.map((row) => row.id)])];
}

function applyVote(feedId: number, storyId: number, wanted: FeedbackReason | null, actor: Actor, now: number): void {
  const sqlite = getSqlite();
  const current = sqlite
    .prepare("SELECT id, reason FROM feedback WHERE feed_id = ? AND story_id = ? AND user_id = ?")
    .get(feedId, storyId, actor.userId) as { id: number; reason: string } | undefined;
  const change = decideChange(current ? asFeedbackReason(current.reason) : null, wanted);
  if (change === "remove" && current) {
    sqlite.prepare("DELETE FROM feedback WHERE id = ?").run(current.id);
  } else if (change === "replace" && current) {
    sqlite
      .prepare("UPDATE feedback SET reason = ?, created_at = ? WHERE id = ?")
      .run(wanted, now, current.id);
  } else if (change === "insert") {
    sqlite
      .prepare("INSERT INTO feedback (feed_id, story_id, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(feedId, storyId, wanted, actor.userId, now);
  }
  if (change !== "none") recomputeJudgements({ feedId, storyIds: storiesToRecompute(feedId, storyId, now) });
}

/**
 * Sets, changes, or removes the vote of this person (`actor.userId`).
 * `reason: null` removes the vote; the active reason again also removes it.
 * The rank of the story (and of the stories that share a source with it)
 * changes in the same transaction (§8.4).
 */
export async function vote(
  feedId: number,
  storyId: number,
  reason: FeedbackReason | null,
  actor: Actor,
): Promise<{ votes: Record<FeedbackReason, number>; myVote: FeedbackReason | null }> {
  const wanted = reason === null ? null : feedbackReasonSchema.safeParse(reason);
  if (wanted !== null && !wanted.success) throw new ServiceError("validation", "This feedback reason does not exist.");

  const sqlite = getSqlite();
  return sqlite
    .transaction(() => {
      if (!hasJudgement(feedId, storyId)) throw new ServiceError("not_found", "This story is not in this feed.");
      applyVote(feedId, storyId, wanted === null ? null : wanted.data, actor, nowMs());
      const mine = sqlite
        .prepare("SELECT reason FROM feedback WHERE feed_id = ? AND story_id = ? AND user_id = ?")
        .get(feedId, storyId, actor.userId) as { reason: string } | undefined;
      return {
        votes: votesForStories(feedId, [storyId]).get(storyId) ?? emptyVotes(),
        myVote: mine ? asFeedbackReason(mine.reason) : null,
      };
    })
    .immediate();
}
