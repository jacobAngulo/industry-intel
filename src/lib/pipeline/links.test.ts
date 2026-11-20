import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DAY_MS, HOUR_MS } from "@/lib/time";
import {
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeStory,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { findLinkJoin, silentJoin } from "./links";
import { feedsNeedingJudgement } from "./rows";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});

afterEach(() => {
  t.cleanup();
});

/** A story with one item of another source at `url`. */
function storyWith(url: string, over: Parameters<typeof makeStory>[0] = {}, links: string[] = []) {
  const source = makeSource();
  const story = makeStory(over);
  const item = makeItem({ sourceId: source.id, storyId: story.id, url, links });
  return { source, story, item };
}

describe("findLinkJoin", () => {
  it("(1) matches an item of another source with the same canonical URL", () => {
    const { story } = storyWith("https://example.com/news/launch");
    const own = makeSource();
    const item = makeItem({ sourceId: own.id, url: "https://example.com/news/launch" });
    expect(findLinkJoin(item.id, NOW)).toEqual({ storyId: story.id, substance: "news", lowSubstance: false });
  });

  it("(2) matches when an item of the story links to this item's URL", () => {
    const { story } = storyWith("https://forum.example.com/t/1", {}, ["https://blog.example.com/post"]);
    const item = makeItem({ sourceId: makeSource().id, url: "https://blog.example.com/post" });
    expect(findLinkJoin(item.id, NOW)?.storyId).toBe(story.id);
  });

  it("(3) matches when this item (with at most 3 links) links to the URL of an item of the story", () => {
    const { story } = storyWith("https://blog.example.com/post");
    const links = ["https://a.example.com/1", "https://a.example.com/2", "https://blog.example.com/post"];
    const item = makeItem({ sourceId: makeSource().id, url: "https://news.ycombinator.com/item?id=1", links });
    expect(findLinkJoin(item.id, NOW)?.storyId).toBe(story.id);
  });

  it("(3) does not apply to an item with more than 3 links", () => {
    storyWith("https://blog.example.com/post");
    const links = ["https://a.example.com/1", "https://a.example.com/2", "https://a.example.com/3", "https://blog.example.com/post"];
    const item = makeItem({ sourceId: makeSource().id, url: "https://hn.example.com/x", links });
    expect(findLinkJoin(item.id, NOW)).toBeNull();
  });

  it("never counts a root URL", () => {
    storyWith("https://example.com/", {}, ["https://example.com"]);
    const same = makeItem({ sourceId: makeSource().id, url: "https://example.com/" });
    const linking = makeItem({ sourceId: makeSource().id, url: "https://other.example.com/x", links: ["https://example.com/"] });
    expect(findLinkJoin(same.id, NOW)).toBeNull();
    expect(findLinkJoin(linking.id, NOW)).toBeNull();
  });

  it("compares only with items of a different source", () => {
    const { source } = storyWith("https://example.com/news/launch");
    const item = makeItem({ sourceId: source.id, url: "https://example.com/news/launch" });
    expect(findLinkJoin(item.id, NOW)).toBeNull();
  });

  it("never joins a doc_change item or an item that is not pending", () => {
    storyWith("https://example.com/news/launch");
    const doc = makeItem({ sourceId: makeSource().id, url: "https://example.com/news/launch", kind: "doc_change" });
    const judged = makeItem({ sourceId: makeSource().id, url: "https://example.com/news/launch", judgeStatus: "judged" });
    expect(findLinkJoin(doc.id, NOW)).toBeNull();
    expect(findLinkJoin(judged.id, NOW)).toBeNull();
  });

  it("only stories with last_item_at in the last 14 days count; the newest story wins", () => {
    storyWith("https://example.com/a", { lastItemAt: NOW - 15 * DAY_MS });
    expect(findLinkJoin(makeItem({ sourceId: makeSource().id, url: "https://example.com/a" }).id, NOW)).toBeNull();

    storyWith("https://example.com/b", { lastItemAt: NOW - 2 * DAY_MS });
    const newer = storyWith("https://example.com/b", { lastItemAt: NOW - HOUR_MS }).story;
    expect(findLinkJoin(makeItem({ sourceId: makeSource().id, url: "https://example.com/b" }).id, NOW)?.storyId).toBe(newer.id);
  });

  it("flags a promo or chatter story (no silent join for it)", () => {
    const { story } = storyWith("https://example.com/promo", { substance: "promo" });
    const item = makeItem({ sourceId: makeSource().id, url: "https://example.com/promo" });
    expect(findLinkJoin(item.id, NOW)).toEqual({ storyId: story.id, substance: "promo", lowSubstance: true });
  });
});

describe("feeds that need a judgement", () => {
  it("lists active feeds of the source with no judgement, or with a 'source filter' judgement from another source", () => {
    const source = makeSource();
    const other = makeSource();
    const noJudgement = makeFeed();
    const judged = makeFeed();
    const filteredByOther = makeFeed();
    const filteredBySame = makeFeed();
    const archived = makeFeed({ archivedAt: NOW });
    for (const feed of [noJudgement, judged, filteredByOther, filteredBySame, archived]) linkFeedSource(feed.id, source.id);
    const story = makeStory();
    const otherItem = makeItem({ sourceId: other.id, storyId: story.id });
    const sameItem = makeItem({ sourceId: source.id, storyId: story.id });
    makeJudgement({ feedId: judged.id, storyId: story.id, sourceItemId: otherItem.id });
    makeJudgement({ feedId: filteredByOther.id, storyId: story.id, exclusion: "source filter", sourceItemId: otherItem.id });
    makeJudgement({ feedId: filteredBySame.id, storyId: story.id, exclusion: "source filter", sourceItemId: sameItem.id });
    expect(feedsNeedingJudgement(story.id, source.id).sort()).toEqual([noJudgement.id, filteredByOther.id].sort());
  });

  it("silentJoin marks the item judged and recomputes the rank when no feed needs a judgement", () => {
    const feed = makeFeed();
    const source = makeSource();
    const other = makeSource();
    linkFeedSource(feed.id, source.id);
    linkFeedSource(feed.id, other.id);
    const story = makeStory({ lastItemAt: NOW - DAY_MS });
    makeItem({ sourceId: other.id, storyId: story.id });
    const judgement = makeJudgement({ feedId: feed.id, storyId: story.id, baseScore: 0 });
    const item = makeItem({ sourceId: source.id, publishedAt: NOW - HOUR_MS });
    expect(silentJoin(item.id, story.id, NOW)).toEqual([]);
    const row = t.sqlite.prepare("SELECT judge_status, story_id FROM items WHERE id = ?").get(item.id);
    expect(row).toEqual({ judge_status: "judged", story_id: story.id });
    const storyRow = t.sqlite.prepare("SELECT item_count, source_count, last_item_at FROM stories WHERE id = ?").get(story.id);
    expect(storyRow).toEqual({ item_count: 2, source_count: 2, last_item_at: NOW - HOUR_MS });
    const score = t.sqlite.prepare("SELECT base_score FROM judgements WHERE id = ?").get(judgement.id) as { base_score: number };
    expect(score.base_score).toBeGreaterThan(0);
  });
});
