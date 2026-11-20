// Applying a judge result (§7.4): one IMMEDIATE transaction, all checks inside.
import { getSqlite } from "@/lib/db/client";
import { upsertStoryFts } from "@/lib/db/fts";
import type { ItemDbRow } from "@/lib/db/schema";
import { recomputeJudgements } from "@/lib/ranking/recompute";
import { isHigherSubstance } from "@/lib/types";

import { createAlerts } from "./alerts";
import { insertJudgement, readJudgement, replaceJudgement, shouldReplace } from "./judgements";
import { attachItemToStory, findLinkJoin } from "./links";
import { searchCandidateIds } from "./prompt-data";
import { activeFeedIdsForSource, itemTime, readItem, readStory } from "./rows";
import { JUDGE_LIMITS, type CleanFeedResult, type CleanItemFacts, type CleanJudgeOutput } from "./schemas";

export interface ApplyInput {
  itemId: number;
  mode: "normal" | "single";
  /** When the model call started: a story created after it can be the same event (regroup). */
  callStartedAt: number;
  output: CleanJudgeOutput;
  /** The MATCH text of the candidate search (normal mode). */
  matchText: string;
  model: string;
  now: number;
}

export type ApplyOutcome = "judged" | "joined" | "regroup" | "skipped";

type StoryChoice = { storyId: number; addsNewFacts: boolean } | "regroup" | null;

/** Step 1: which story the item joins (normal mode). Null = a new story. */
function chooseStory(item: ItemDbRow, facts: CleanItemFacts, input: ApplyInput): StoryChoice {
  if (facts.sameStoryId !== null && readStory(facts.sameStoryId)) {
    return { storyId: facts.sameStoryId, addsNewFacts: facts.addsNewFacts };
  }
  const link = findLinkJoin(item.id, input.now);
  if (link) return { storyId: link.storyId, addsNewFacts: false };
  if (item.meta.regroup !== true) {
    const newer = searchCandidateIds(input.matchText, input.now).some((id) => {
      const story = readStory(id);
      return story !== null && story.createdAt > input.callStartedAt;
    });
    if (newer) return "regroup";
  }
  return null;
}

function markRegroup(item: ItemDbRow): void {
  getSqlite()
    .prepare("UPDATE items SET meta = ?, judge_locked_until = NULL WHERE id = ?")
    .run(JSON.stringify({ ...item.meta, regroup: true }), item.id);
}

function createStory(item: ItemDbRow, facts: CleanItemFacts, now: number): number {
  const sqlite = getSqlite();
  const time = Math.min(now, itemTime(item));
  const result = sqlite
    .prepare(
      `INSERT INTO stories (headline, summary, category, entities, substance, first_seen_at, last_item_at, fresh_at,
                            item_count, source_count, primary_item_id, primary_url, created_at, updated_at)
       VALUES (@headline, @summary, @category, @entities, @substance, @time, @time, @time, 1, 1, @itemId, @url, @now, @now)`,
    )
    .run({
      headline: facts.headline,
      summary: JSON.stringify(facts.summary),
      category: facts.category,
      entities: JSON.stringify(facts.entities),
      substance: facts.substance,
      time,
      itemId: item.id,
      url: item.url,
      now,
    });
  const storyId = Number(result.lastInsertRowid);
  sqlite.prepare("UPDATE items SET story_id = ?, substance = ? WHERE id = ?").run(storyId, facts.substance, item.id);
  upsertStoryFts(storyId, facts.headline, facts.summary, facts.entities);
  return storyId;
}

/** The sentences of the item first, then the old ones (exact duplicates removed), cut to 5. */
export function mergeSummary(itemSentences: string[], oldSentences: string[]): string[] {
  const out: string[] = [];
  for (const sentence of [...itemSentences, ...oldSentences]) if (!out.includes(sentence)) out.push(sentence);
  return out.slice(0, JUDGE_LIMITS.summaryMax);
}

/**
 * Step 2: the join effects. A higher substance replaces the facts of the
 * story; else new facts extend the summary. In both cases fresh_at moves
 * forward (never back).
 */
function joinStory(item: ItemDbRow, storyId: number, facts: CleanItemFacts, addsNewFacts: boolean, now: number): void {
  const sqlite = getSqlite();
  attachItemToStory(item.id, storyId, now);
  sqlite.prepare("UPDATE items SET substance = ? WHERE id = ?").run(facts.substance, item.id);
  const story = readStory(storyId);
  if (!story) return;
  const fresh = Math.max(story.freshAt, Math.min(now, itemTime(item)));

  if (isHigherSubstance(facts.substance, story.substance)) {
    sqlite
      .prepare(
        `UPDATE stories SET headline = @headline, summary = @summary, category = @category, entities = @entities,
                substance = @substance, primary_item_id = @itemId, primary_url = @url, fresh_at = @fresh, updated_at = @now
          WHERE id = @storyId`,
      )
      .run({
        storyId,
        headline: facts.headline,
        summary: JSON.stringify(facts.summary),
        category: facts.category,
        entities: JSON.stringify(facts.entities),
        substance: facts.substance,
        itemId: item.id,
        url: item.url,
        fresh,
        now,
      });
    upsertStoryFts(storyId, facts.headline, facts.summary, facts.entities);
  } else if (addsNewFacts) {
    const summary = mergeSummary(facts.summary, story.summary);
    sqlite
      .prepare("UPDATE stories SET summary = ?, fresh_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(summary), fresh, now, storyId);
    upsertStoryFts(storyId, story.headline, summary, story.entities);
  }
}

/**
 * Step 3: the feed results. Results for feeds that are not active or do not
 * use the item's source now are dropped. Returns the results that were
 * written (inserted or replaced).
 */
function writeFeedResults(
  item: ItemDbRow,
  storyId: number,
  results: CleanFeedResult[],
  addsNewFacts: boolean,
  model: string,
  now: number,
): CleanFeedResult[] {
  const active = new Set(activeFeedIdsForSource(item.sourceId));
  const written: CleanFeedResult[] = [];
  for (const result of results) {
    if (!active.has(result.feedId)) continue;
    const old = readJudgement(result.feedId, storyId);
    if (!old) {
      insertJudgement(storyId, result, item.id, model, now);
      written.push(result);
    } else if (shouldReplace(old, result, { sourceId: item.sourceId, textLength: item.contentText.length }, addsNewFacts)) {
      replaceJudgement(old.id, result, item.id, model, now);
      written.push(result);
    }
  }
  return written;
}

/**
 * Step 4: the item is `judged` when each active feed that uses its source
 * has a judgement of the story; else it stays `pending` for the single-story
 * mode (it has a story now). The lock is cleared in both cases.
 */
function finishItem(item: ItemDbRow, storyId: number, now: number): void {
  const sqlite = getSqlite();
  const has = sqlite.prepare("SELECT 1 FROM judgements WHERE feed_id = ? AND story_id = ?");
  const missing = activeFeedIdsForSource(item.sourceId).some((feedId) => !has.get(feedId, storyId));
  if (missing) {
    sqlite.prepare("UPDATE items SET judge_locked_until = NULL, judge_error = NULL WHERE id = ?").run(item.id);
  } else {
    sqlite
      .prepare(
        `UPDATE items SET judge_status = 'judged', judged_at = ?, judge_locked_until = NULL, judge_error = NULL,
                next_judge_at = NULL WHERE id = ?`,
      )
      .run(now, item.id);
  }
}

/** The apply step of §7.4 (steps 0 to 6). */
export function applyJudgeResult(input: ApplyInput): ApplyOutcome {
  const sqlite = getSqlite();
  return sqlite
    .transaction((): ApplyOutcome => {
      // 0. Another path handled the item during the call.
      const item = readItem(input.itemId);
      if (!item || item.judgeStatus !== "pending") return "skipped";

      let storyId: number;
      let joined = false;
      let addsNewFacts = false;
      if (input.mode === "single") {
        if (item.storyId === null) return "skipped";
        storyId = item.storyId;
      } else {
        const facts = input.output.item;
        if (!facts) return "skipped";
        const choice = chooseStory(item, facts, input);
        if (choice === "regroup") {
          markRegroup(item);
          return "regroup";
        }
        if (choice === null) {
          storyId = createStory(item, facts, input.now);
        } else {
          storyId = choice.storyId;
          addsNewFacts = choice.addsNewFacts;
          joined = true;
          joinStory(item, storyId, facts, addsNewFacts, input.now);
        }
      }

      const written = writeFeedResults(item, storyId, input.output.feeds, addsNewFacts, input.model, input.now);
      finishItem(item, storyId, input.now);
      // 5. All judgements of the story: the source count, the substance, or a verdict changed.
      recomputeJudgements({ storyIds: [storyId] });
      createAlerts(storyId, written, input.now);
      return joined ? "joined" : "judged";
    })
    .immediate();
}
