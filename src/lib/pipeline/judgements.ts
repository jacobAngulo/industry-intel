// Writing judgements (§7.4 step 3, §7.6). The rank fields get placeholder
// values here; the caller runs recomputeJudgements in the same transaction.
import { getSqlite } from "@/lib/db/client";

import { SOURCE_FILTER_EXCLUSION, type CleanFeedResult } from "./schemas";

export interface ExistingJudgement {
  id: number;
  relevance: number;
  exclusion: string | null;
  /** The source of the item that produced it; null when that item is gone. */
  itemSourceId: number | null;
  /** The text length of the item that produced it; 0 when that item is gone. */
  itemTextLength: number;
}

export function readJudgement(feedId: number, storyId: number): ExistingJudgement | null {
  const row = getSqlite()
    .prepare(
      `SELECT j.id AS id, j.relevance AS relevance, j.exclusion AS exclusion, si.source_id AS itemSourceId,
              COALESCE(LENGTH(si.content_text), 0) AS itemTextLength
         FROM judgements j LEFT JOIN items si ON si.id = j.source_item_id
        WHERE j.feed_id = ? AND j.story_id = ?`,
    )
    .get(feedId, storyId) as ExistingJudgement | undefined;
  return row ?? null;
}

/**
 * The replace rules of §7.4 step 3. A result with exclusion 'source filter'
 * never replaces a judgement with no exclusion. Else replace when the new
 * item has at least 1.5 times the text of the old item, when it adds new facts
 * and scores higher, or when the old judgement was a 'source filter'
 * exclusion from a different source.
 */
export function shouldReplace(
  old: ExistingJudgement,
  result: CleanFeedResult,
  item: { sourceId: number; textLength: number },
  addsNewFacts: boolean,
): boolean {
  if (result.exclusion === SOURCE_FILTER_EXCLUSION && old.exclusion === null) return false;
  if (item.textLength >= 1.5 * old.itemTextLength) return true;
  if (addsNewFacts && result.relevance > old.relevance) return true;
  return old.exclusion === SOURCE_FILTER_EXCLUSION && old.itemSourceId !== item.sourceId;
}

function values(result: CleanFeedResult) {
  return {
    relevance: result.relevance,
    reason: result.reason,
    whyItMatters: result.whyItMatters,
    suggestedAction: result.suggestedAction,
    topicIds: JSON.stringify(result.topicIds),
    exclusion: result.exclusion,
    novelty: result.novelty,
    depth: result.depth,
    signals: JSON.stringify(result.signals),
    alert: result.alert ? 1 : 0,
  };
}

/** Inserts a judgement (created_at = judged_at = now). */
export function insertJudgement(storyId: number, result: CleanFeedResult, itemId: number, model: string, now: number): void {
  getSqlite()
    .prepare(
      `INSERT INTO judgements (feed_id, story_id, relevance, reason, why_it_matters, suggested_action, topic_ids, exclusion,
                               novelty, depth, signals, alert, base_score, rank_parts, hidden_reason, source_item_id,
                               model, created_at, judged_at, updated_at)
       VALUES (@feedId, @storyId, @relevance, @reason, @whyItMatters, @suggestedAction, @topicIds, @exclusion,
               @novelty, @depth, @signals, @alert, 0, '[]', NULL, @itemId, @model, @now, @now, @now)`,
    )
    .run({ feedId: result.feedId, storyId, itemId, model, now, ...values(result) });
}

/** Replaces the verdict of a judgement. created_at stays; judged_at = now. */
export function replaceJudgement(judgementId: number, result: CleanFeedResult, itemId: number, model: string, now: number): void {
  getSqlite()
    .prepare(
      `UPDATE judgements
          SET relevance = @relevance, reason = @reason, why_it_matters = @whyItMatters,
              suggested_action = @suggestedAction, topic_ids = @topicIds, exclusion = @exclusion, novelty = @novelty,
              depth = @depth, signals = @signals, alert = @alert, source_item_id = @itemId, model = @model,
              judged_at = @now, updated_at = @now
        WHERE id = @id`,
    )
    .run({ id: judgementId, itemId, model, now, ...values(result) });
}
