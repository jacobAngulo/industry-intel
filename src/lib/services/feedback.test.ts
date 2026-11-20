import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSqlite } from "@/lib/db/client";
import { DAY_MS } from "@/lib/time";
import type { FeedbackReason } from "@/lib/types";
import { installTestDb, makeItem, makeSource, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { NOW, feedWithSource, judgedStory } from "./_read-testkit";
import { vote } from "./feedback";
import { listFeedStories } from "./stories";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

const actor = (clientId: string, name = "Someone") => ({ name, clientId });

function judgementOf(feedId: number, storyId: number): { hiddenReason: string | null; baseScore: number } {
  return getSqlite()
    .prepare("SELECT hidden_reason AS hiddenReason, base_score AS baseScore FROM judgements WHERE feed_id = ? AND story_id = ?")
    .get(feedId, storyId) as { hiddenReason: string | null; baseScore: number };
}

function voteRows(feedId: number, storyId: number): Array<{ reason: string; clientId: string; createdBy: string }> {
  return getSqlite()
    .prepare("SELECT reason, client_id AS clientId, created_by AS createdBy FROM feedback WHERE feed_id = ? AND story_id = ?")
    .all(feedId, storyId) as Array<{ reason: string; clientId: string; createdBy: string }>;
}

describe("vote: one vote for each browser (§4.3)", () => {
  it("stores a vote without a real name and returns the counts and my vote", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    const result = await vote(feed.id, story.id, "useful", actor("c1"));
    expect(result).toEqual({ votes: { useful: 1, too_basic: 0, off_topic: 0, already_knew: 0 }, myVote: "useful" });
    expect(voteRows(feed.id, story.id)).toEqual([{ reason: "useful", clientId: "c1", createdBy: "Someone" }]);
  });

  it("removes the vote when the same reason comes again (toggle)", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    await vote(feed.id, story.id, "already_knew", actor("c1"));
    const result = await vote(feed.id, story.id, "already_knew", actor("c1"));
    expect(result.myVote).toBeNull();
    expect(result.votes.already_knew).toBe(0);
    expect(voteRows(feed.id, story.id)).toEqual([]);
  });

  it("replaces the vote with another reason", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    await vote(feed.id, story.id, "useful", actor("c1"));
    const result = await vote(feed.id, story.id, "too_basic", actor("c1", "Dana"));
    expect(result).toEqual({ votes: { useful: 0, too_basic: 1, off_topic: 0, already_knew: 0 }, myVote: "too_basic" });
    expect(voteRows(feed.id, story.id)).toEqual([{ reason: "too_basic", clientId: "c1", createdBy: "Dana" }]);
  });

  it("removes the vote with reason null, and null with no vote changes nothing", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    expect((await vote(feed.id, story.id, null, actor("c1"))).myVote).toBeNull();
    await vote(feed.id, story.id, "off_topic", actor("c1"));
    await vote(feed.id, story.id, "off_topic", actor("c2"));
    const result = await vote(feed.id, story.id, null, actor("c1"));
    expect(result).toEqual({ votes: { useful: 0, too_basic: 0, off_topic: 1, already_knew: 0 }, myVote: null });
  });

  it("keeps the votes of each feed apart", async () => {
    const a = feedWithSource();
    const { story } = judgedStory(a.feed.id, a.source.id);
    const b = feedWithSource();
    getSqlite()
      .prepare(
        `INSERT INTO judgements (feed_id, story_id, relevance, topic_ids, novelty, depth, signals, rank_parts, created_at, judged_at, updated_at)
         VALUES (?, ?, 70, '[]', 'new', 'basic', '{}', '[]', ?, ?, ?)`,
      )
      .run(b.feed.id, story.id, NOW, NOW, NOW);
    await vote(a.feed.id, story.id, "useful", actor("c1"));
    const result = await vote(b.feed.id, story.id, "off_topic", actor("c1"));
    expect(result.votes).toEqual({ useful: 0, too_basic: 0, off_topic: 1, already_knew: 0 });
    expect(voteRows(a.feed.id, story.id)).toHaveLength(1);
  });

  it("refuses a story that has no judgement in the feed, an unknown reason, and an empty client id", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    await expect(vote(feed.id, 999, "useful", actor("c1"))).rejects.toMatchObject({ code: "not_found" });
    await expect(vote(feed.id, story.id, "loved_it" as FeedbackReason, actor("c1"))).rejects.toMatchObject({ code: "validation" });
    await expect(vote(feed.id, story.id, "useful", actor("  "))).rejects.toMatchObject({ code: "validation" });
    expect(voteRows(feed.id, story.id)).toEqual([]);
  });
});

describe("vote: the effect is immediate (§8.4)", () => {
  it("hides a story for everybody after 2 off-topic votes, and shows it again with more useful votes", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id, { judgement: { relevance: 80 } });
    const visibleTo = async (clientId: string) =>
      (await listFeedStories({ feedId: feed.id, window: "week", sort: "top", filtered: false, clientId, now: NOW })).stories.map(
        (card) => card.storyId,
      );

    await vote(feed.id, story.id, "off_topic", actor("c1"));
    expect(judgementOf(feed.id, story.id).hiddenReason).toBeNull();
    expect(await visibleTo("c3")).toEqual([story.id]);

    await vote(feed.id, story.id, "off_topic", actor("c2"));
    expect(judgementOf(feed.id, story.id).hiddenReason).toBe("feedback");
    expect(await visibleTo("c3")).toEqual([]);

    // off_topic 2 > useful 1: still hidden; off_topic 2 = useful 2: visible (§8.1 rule 2).
    await vote(feed.id, story.id, "useful", actor("c3"));
    expect(judgementOf(feed.id, story.id).hiddenReason).toBe("feedback");
    await vote(feed.id, story.id, "useful", actor("c4"));
    expect(judgementOf(feed.id, story.id).hiddenReason).toBeNull();
    expect(await visibleTo("c3")).toEqual([story.id]);
    // The voters of "off topic" still do not see it (their own vote, §8.1).
    expect(await visibleTo("c1")).toEqual([]);
  });

  it("changes the base score of the voted story (term F)", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id, { base: 1, judgement: { relevance: 70 } });
    await vote(feed.id, story.id, "useful", actor("c1"));
    const withUseful = judgementOf(feed.id, story.id).baseScore;
    await vote(feed.id, story.id, null, actor("c1"));
    expect(withUseful - judgementOf(feed.id, story.id).baseScore).toBe(6);
  });

  it("recomputes the feed's stories of the last 14 days that share a source, and no other", async () => {
    const { feed, source } = feedWithSource();
    const voted = judgedStory(feed.id, source.id).story;
    const sibling = judgedStory(feed.id, source.id, { base: 1 }).story;
    const old = judgedStory(feed.id, source.id, {
      base: 1,
      ageHours: 20 * 24,
      judgement: { createdAt: NOW - 20 * DAY_MS },
    }).story;
    const stranger = makeSource();
    const unrelated = judgedStory(feed.id, stranger.id, { base: 1 }).story;
    // A second source in the voted story: its other stories count too.
    const partner = makeSource();
    makeItem({ sourceId: partner.id, storyId: voted.id });
    const viaPartner = judgedStory(feed.id, partner.id, { base: 1 }).story;

    await vote(feed.id, voted.id, "useful", actor("c1"));

    expect(judgementOf(feed.id, sibling.id).baseScore).not.toBe(1);
    expect(judgementOf(feed.id, viaPartner.id).baseScore).not.toBe(1);
    expect(judgementOf(feed.id, old.id).baseScore).toBe(1);
    expect(judgementOf(feed.id, unrelated.id).baseScore).toBe(1);
  });

  it("moves the term Q of a sibling story once the source has 3 votes", async () => {
    const { feed, source } = feedWithSource();
    const voted = judgedStory(feed.id, source.id).story;
    const sibling = judgedStory(feed.id, source.id, { judgement: { relevance: 70 } }).story;
    await vote(feed.id, voted.id, "off_topic", actor("c1"));
    const before = judgementOf(feed.id, sibling.id).baseScore;
    await vote(feed.id, voted.id, "off_topic", actor("c2"));
    await vote(feed.id, voted.id, "off_topic", actor("c3"));
    expect(judgementOf(feed.id, sibling.id).baseScore).toBeLessThan(before);
  });
});
