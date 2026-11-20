import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { judgements, settings, topics } from "@/lib/db/schema";
import {
  addVote,
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeStory,
  makeTopic,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";
import { feedTopics } from "@/lib/db/schema";
import { DAY_MS } from "@/lib/time";

import { readBriefDefaults, recomputeJudgements, sourceQualityForFeed, votesForStories } from "./recompute";

const NOW = Date.parse("2026-11-20T12:00:00Z");

let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});

afterEach(() => t.cleanup());

function judgementRow(id: number) {
  return t.db.select().from(judgements).where(eq(judgements.id, id)).get()!;
}

/** A feed with one source, one story with one item of that source, and one judgement. */
function setup(options: { relevance?: number; priority?: "high" | "normal" | "low" } = {}) {
  const feed = makeFeed({ relevancePriorities: { practical: "off", experiment: "off", other: "" } });
  const source = makeSource();
  linkFeedSource(feed.id, source.id, { priority: options.priority ?? "normal" });
  const story = makeStory();
  makeItem({ sourceId: source.id, storyId: story.id });
  const judgement = makeJudgement({
    feedId: feed.id,
    storyId: story.id,
    relevance: options.relevance ?? 70,
    depth: "advanced",
    baseScore: 0,
    rankParts: [],
  });
  return { feed, source, story, judgement };
}

describe("votesForStories", () => {
  it("counts the votes of each story in one feed, with zero for each requested story", () => {
    const { feed, story } = setup();
    const other = makeStory();
    const otherFeed = makeFeed();
    addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: story.id, reason: "off_topic" });
    addVote({ feedId: otherFeed.id, storyId: story.id, reason: "too_basic" });

    const votes = votesForStories(feed.id, [story.id, other.id]);
    expect(votes.get(story.id)).toEqual({ useful: 2, too_basic: 0, off_topic: 1, already_knew: 0 });
    expect(votes.get(other.id)).toEqual({ useful: 0, too_basic: 0, off_topic: 0, already_knew: 0 });
    expect(votesForStories(feed.id, []).size).toBe(0);
  });
});

describe("sourceQualityForFeed", () => {
  it("counts the votes of the last 90 days in this feed on stories with an item of the source", () => {
    const { feed, source, story } = setup();
    const otherSource = makeSource();
    const story2 = makeStory();
    makeItem({ sourceId: source.id, storyId: story2.id });
    makeItem({ sourceId: otherSource.id, storyId: story2.id });
    // Two items of one source in one story: one vote still counts one time.
    makeItem({ sourceId: source.id, storyId: story.id });

    addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: story2.id, reason: "off_topic" });
    addVote({ feedId: feed.id, storyId: story2.id, reason: "too_basic" });
    addVote({ feedId: feed.id, storyId: story2.id, reason: "already_knew" });
    // Too old, and another feed: not counted.
    addVote({ feedId: feed.id, storyId: story.id, reason: "useful", createdAt: NOW - 91 * DAY_MS });
    addVote({ feedId: makeFeed().id, storyId: story.id, reason: "useful" });

    const quality = sourceQualityForFeed(feed.id, NOW);
    expect(quality.get(source.id)).toEqual({ useful: 1, offTopic: 1, tooBasic: 1 });
    expect(quality.get(otherSource.id)).toEqual({ useful: 0, offTopic: 1, tooBasic: 1 });
  });
});

describe("readBriefDefaults", () => {
  it("uses the built-in defaults when the row is absent or broken", () => {
    expect(readBriefDefaults()).toEqual({ summaryLength: "standard", technicalDepth: "practitioner", suggestedActions: true });
    t.db.insert(settings).values({ key: "brief_defaults", value: { summaryLength: "short", technicalDepth: "x" }, updatedAt: NOW }).run();
    expect(readBriefDefaults()).toEqual({ summaryLength: "short", technicalDepth: "practitioner", suggestedActions: true });
  });
});

describe("recomputeJudgements", () => {
  it("writes base_score, rank_parts, and hidden_reason", () => {
    const { judgement } = setup({ relevance: 70, priority: "high" });
    expect(recomputeJudgements({})).toBe(1);
    const row = judgementRow(judgement.id);
    expect(row.baseScore).toBe(75);
    expect(row.hiddenReason).toBeNull();
    expect(row.rankParts.map((part) => part.key)).toEqual(["relevance", "source_priority"]);
  });

  it("hides with below_threshold by the minimum relevance of the feed", () => {
    const { judgement } = setup({ relevance: 55 });
    recomputeJudgements({ storyIds: [judgement.storyId] });
    expect(judgementRow(judgement.id).hiddenReason).toBe("below_threshold");
  });

  it("source_removed when no item of the story is from a source in the feed now", () => {
    const { judgement, story } = setup();
    const outside = makeSource();
    makeItem({ sourceId: outside.id, storyId: story.id });
    t.sqlite.prepare("DELETE FROM feed_sources").run();
    recomputeJudgements({ feedId: judgement.feedId });
    expect(judgementRow(judgement.id).hiddenReason).toBe("source_removed");
  });

  it("S is the highest priority among the story's sources that are in the feed", () => {
    const { feed, story, judgement } = setup({ priority: "low" });
    const second = makeSource();
    linkFeedSource(feed.id, second.id, { priority: "high" });
    makeItem({ sourceId: second.id, storyId: story.id });
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "source_priority")?.value).toBe(5);
  });

  it("uses the topic priorities of the feed; no row = normal; an archived topic is ignored", () => {
    const { feed, judgement } = setup();
    const high = makeTopic({ name: "Coding agents" });
    const low = makeTopic({ name: "Old topic" });
    const plain = makeTopic({ name: "Plain" });
    t.db.insert(feedTopics).values([
      { feedId: feed.id, topicId: high.id, priority: "high" },
      { feedId: feed.id, topicId: low.id, priority: "low" },
    ]).run();
    t.db.update(judgements).set({ topicIds: [high.id, low.id, 9999] }).where(eq(judgements.id, judgement.id)).run();
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).rankParts[1]).toEqual({ key: "topic", label: 'Topic "Coding agents" is high priority', value: 8 });

    // Archive the high topic: only the low topic stays -> -8.
    t.db.update(topics).set({ archivedAt: NOW }).where(eq(topics.id, high.id)).run();
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "topic")?.value).toBe(-8);

    // A topic with no row is normal: not all are low -> no topic part.
    t.db.update(judgements).set({ topicIds: [low.id, plain.id] }).where(eq(judgements.id, judgement.id)).run();
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "topic")).toBeUndefined();
  });

  it("hides a judgement with a muted topic", () => {
    const { feed, judgement } = setup();
    const muted = makeTopic();
    t.db.insert(feedTopics).values({ feedId: feed.id, topicId: muted.id, priority: "muted" }).run();
    t.db.update(judgements).set({ topicIds: [muted.id] }).where(eq(judgements.id, judgement.id)).run();
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).hiddenReason).toBe("muted_topic");
  });

  it("uses the votes on the story in this feed (F) and the feedback rule", () => {
    const { feed, story, judgement } = setup({ relevance: 70 });
    addVote({ feedId: feed.id, storyId: story.id, reason: "off_topic" });
    addVote({ feedId: feed.id, storyId: story.id, reason: "off_topic" });
    recomputeJudgements({ storyIds: [story.id] });
    const row = judgementRow(judgement.id);
    expect(row.hiddenReason).toBe("feedback");
    expect(row.rankParts.find((part) => part.key === "votes")?.value).toBe(-20);
  });

  it("Q: the highest q among the sources of the story in the feed (votes of the last 90 days)", () => {
    const { feed, source, story, judgement } = setup();
    // Three useful votes on other stories of the source: q = (4/5 - 0.5) × 10 = 3.
    for (let i = 0; i < 3; i += 1) {
      const other = makeStory();
      makeItem({ sourceId: source.id, storyId: other.id });
      addVote({ feedId: feed.id, storyId: other.id, reason: "useful" });
    }
    recomputeJudgements({ storyIds: [story.id] });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "source_quality")?.value).toBe(3);
  });

  it("uses the feed technical depth, or the shared default when the feed has none", () => {
    const { feed, judgement } = setup();
    t.db.update(judgements).set({ depth: "basic" }).where(eq(judgements.id, judgement.id)).run();
    recomputeJudgements({ feedId: feed.id });
    // Built-in default: practitioner -> basic -6.
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "depth")?.value).toBe(-6);

    t.db.insert(settings).values({ key: "brief_defaults", value: { summaryLength: "standard", technicalDepth: "deep", suggestedActions: true }, updatedAt: NOW }).run();
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "depth")?.value).toBe(-12);

    t.sqlite.prepare("UPDATE feeds SET brief_format = ? WHERE id = ?").run(JSON.stringify({ summaryLength: null, technicalDepth: "overview", suggestedActions: null }), feed.id);
    recomputeJudgements({ feedId: feed.id });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "depth")).toBeUndefined();
  });

  it("uses the source count of the story (C)", () => {
    const { story, judgement } = setup();
    t.sqlite.prepare("UPDATE stories SET source_count = 4 WHERE id = ?").run(story.id);
    recomputeJudgements({ storyIds: [story.id] });
    expect(judgementRow(judgement.id).rankParts.find((part) => part.key === "corroboration")?.value).toBe(6);
  });

  it("hides a story with low substance", () => {
    const { story, judgement } = setup();
    t.sqlite.prepare("UPDATE stories SET substance = 'promo' WHERE id = ?").run(story.id);
    recomputeJudgements({ storyIds: [story.id] });
    expect(judgementRow(judgement.id).hiddenReason).toBe("low_substance");
  });

  it("limits the scope by feedId, storyIds, and sinceMs", () => {
    const a = setup();
    const b = setup();
    const old = makeStory({ freshAt: NOW - 40 * DAY_MS });
    makeItem({ sourceId: a.source.id, storyId: old.id });
    const oldJudgement = makeJudgement({ feedId: a.feed.id, storyId: old.id, createdAt: NOW - 40 * DAY_MS, baseScore: 0, rankParts: [] });

    expect(recomputeJudgements({ feedId: a.feed.id })).toBe(2);
    expect(recomputeJudgements({ feedId: a.feed.id, sinceMs: 30 * DAY_MS })).toBe(1);
    expect(judgementRow(oldJudgement.id).baseScore).toBeGreaterThan(0);
    expect(recomputeJudgements({ storyIds: [b.story.id] })).toBe(1);
    expect(recomputeJudgements({ storyIds: [] })).toBe(0);
    expect(recomputeJudgements({ feedId: a.feed.id, storyIds: [b.story.id] })).toBe(0);
    expect(recomputeJudgements({})).toBe(3);
  });

  it("is safe inside a transaction of the caller (a rollback undoes it)", () => {
    const { judgement } = setup({ relevance: 70 });
    const inside = t.sqlite.transaction(() => recomputeJudgements({}));
    expect(inside.immediate()).toBe(1);
    expect(judgementRow(judgement.id).baseScore).toBe(70);

    t.sqlite.prepare("UPDATE judgements SET base_score = 0").run();
    expect(() =>
      t.db.transaction(
        () => {
          recomputeJudgements({});
          throw new Error("roll back");
        },
        { behavior: "immediate" },
      ),
    ).toThrow("roll back");
    expect(judgementRow(judgement.id).baseScore).toBe(0);
  });

  it("is fast for some hundred judgements", () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const topic = makeTopic();
    for (let i = 0; i < 400; i += 1) {
      const story = makeStory();
      makeItem({ sourceId: source.id, storyId: story.id });
      makeJudgement({ feedId: feed.id, storyId: story.id, topicIds: [topic.id] });
      if (i % 5 === 0) addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    }
    const started = performance.now();
    expect(recomputeJudgements({ feedId: feed.id })).toBe(400);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
