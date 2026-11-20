// Test setup shared by the tests of the read services. Only test files import it.
import { getSqlite } from "@/lib/db/client";
import type { FeedDbRow, ItemDbRow, JudgementDbRow, SourceDbRow, StoryDbRow } from "@/lib/db/schema";
import { HOUR_MS } from "@/lib/time";
import { linkFeedSource, makeFeed, makeItem, makeJudgement, makeSource, makeStory } from "@/test/helpers";

/** 2026-11-20 12:00 UTC: a fixed clock for the tests. */
export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

export interface FeedWithSource {
  feed: FeedDbRow;
  source: SourceDbRow;
}

/** A feed with one source in it. */
export function feedWithSource(feedOverrides: Parameters<typeof makeFeed>[0] = {}): FeedWithSource {
  const feed = makeFeed(feedOverrides);
  const source = makeSource();
  linkFeedSource(feed.id, source.id);
  return { feed, source };
}

export interface JudgedStory {
  story: StoryDbRow;
  item: ItemDbRow;
  judgement: JudgementDbRow;
}

/**
 * A story with one item of `sourceId` (the primary item) and a judgement in
 * the feed. `ageHours` sets fresh_at; `base` sets the base score.
 */
export function judgedStory(
  feedId: number,
  sourceId: number,
  opts: {
    ageHours?: number;
    base?: number;
    story?: Parameters<typeof makeStory>[0];
    item?: Partial<Parameters<typeof makeItem>[0]>;
    judgement?: Partial<Parameters<typeof makeJudgement>[0]>;
  } = {},
): JudgedStory {
  const at = NOW - (opts.ageHours ?? 1) * HOUR_MS;
  const story = makeStory({ freshAt: at, firstSeenAt: at, lastItemAt: at, createdAt: at, ...opts.story });
  const item = makeItem({ sourceId, storyId: story.id, publishedAt: at, fetchedAt: at, ...opts.item });
  getSqlite().prepare("UPDATE stories SET primary_item_id = ?, primary_url = ? WHERE id = ?").run(item.id, item.url, story.id);
  const judgement = makeJudgement({
    feedId,
    storyId: story.id,
    baseScore: opts.base ?? 75,
    createdAt: at,
    judgedAt: at,
    updatedAt: at,
    ...opts.judgement,
  });
  return { story: { ...story, primaryItemId: item.id, primaryUrl: item.url }, item, judgement };
}
