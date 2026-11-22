import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSqlite } from "@/lib/db/client";
import { HOUR_MS } from "@/lib/time";
import { HIDDEN_REASONS } from "@/lib/types";
import {
  addVote,
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeTopic,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { NOW, feedWithSource, judgedStory } from "./_read-testkit";
import { getStory, listFeedStories } from "./stories";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

type ListArgs = Parameters<typeof listFeedStories>[0];
const list = (feedId: number, args: Partial<ListArgs> = {}) =>
  listFeedStories({ feedId, window: "week", sort: "top", filtered: false, userId: "me", now: NOW, ...args });
const ids = (result: Awaited<ReturnType<typeof listFeedStories>>) => result.stories.map((card) => card.storyId);

function addAlert(feedId: number, storyId: number, visibleAt: number): number {
  return Number(
    getSqlite()
      .prepare("INSERT INTO alerts (feed_id, story_id, created_at, visible_at) VALUES (?, ?, ?, ?)")
      .run(feedId, storyId, visibleAt, visibleAt).lastInsertRowid,
  );
}

describe("listFeedStories: window", () => {
  it("filters on stories.fresh_at: today 24 h, week 7 days, month 30 days", async () => {
    const { feed, source } = feedWithSource();
    const a = judgedStory(feed.id, source.id, { ageHours: 2 }).story.id;
    const b = judgedStory(feed.id, source.id, { ageHours: 3 * 24 }).story.id;
    const c = judgedStory(feed.id, source.id, { ageHours: 20 * 24 }).story.id;
    judgedStory(feed.id, source.id, { ageHours: 40 * 24 });

    expect(ids(await list(feed.id, { window: "today" }))).toEqual([a]);
    expect(new Set(ids(await list(feed.id, { window: "week" })))).toEqual(new Set([a, b]));
    expect(new Set(ids(await list(feed.id, { window: "month" })))).toEqual(new Set([a, b, c]));
    expect((await list(feed.id, { window: "month" })).visibleCount).toBe(3);
  });

  it("uses fresh_at, not the judgement time", async () => {
    const { feed, source } = feedWithSource();
    const old = judgedStory(feed.id, source.id, { ageHours: 30, judgement: { createdAt: NOW } }).story.id;
    expect(ids(await list(feed.id, { window: "today" }))).not.toContain(old);
  });

  it("returns an empty list for a feed that does not exist", async () => {
    const result = await list(999);
    expect(result).toMatchObject({ stories: [], visibleCount: 0, filteredCount: 0, hasMore: false, backfill: null });
  });

  it("shows only the judgements of this feed", async () => {
    const { feed, source } = feedWithSource();
    const other = makeFeed();
    judgedStory(other.id, source.id);
    expect((await list(feed.id)).stories).toEqual([]);
  });
});

describe("listFeedStories: visibility (§8.1)", () => {
  it("lists hidden judgements only in the filtered list, each with its reason", async () => {
    const { feed, source } = feedWithSource();
    const visible = judgedStory(feed.id, source.id).story.id;
    const hiddenIds = new Map<string, number>();
    for (const reason of HIDDEN_REASONS) {
      hiddenIds.set(reason, judgedStory(feed.id, source.id, { judgement: { hiddenReason: reason } }).story.id);
    }

    const main = await list(feed.id);
    expect(ids(main)).toEqual([visible]);
    expect(main.visibleCount).toBe(1);
    expect(main.filteredCount).toBe(HIDDEN_REASONS.length);

    const filtered = await list(feed.id, { filtered: true });
    expect(filtered.stories).toHaveLength(HIDDEN_REASONS.length);
    for (const card of filtered.stories) {
      expect(hiddenIds.get(card.hidden as string)).toBe(card.storyId);
    }
    expect(filtered.visibleCount).toBe(1);
    expect(filtered.filteredCount).toBe(HIDDEN_REASONS.length);
  });

  it.each(["off_topic", "too_basic"] as const)("hides a story for the browser whose own vote is %s (my_vote)", async (reason) => {
    const { feed, source } = feedWithSource();
    const story = judgedStory(feed.id, source.id).story.id;
    addVote({ feedId: feed.id, storyId: story, reason, userId: "me" });

    const mine = await list(feed.id);
    expect(ids(mine)).toEqual([]);
    expect(mine.filteredCount).toBe(1);
    const filtered = await list(feed.id, { filtered: true });
    expect(filtered.stories[0]).toMatchObject({ storyId: story, hidden: "my_vote", myVote: reason });

    const theirs = await list(feed.id, { userId: "someone-else" });
    expect(ids(theirs)).toEqual([story]);
    expect(theirs.stories[0]?.myVote).toBeNull();
  });

  it.each(["useful", "already_knew"] as const)("does not hide a story for an own vote %s", async (reason) => {
    const { feed, source } = feedWithSource();
    const story = judgedStory(feed.id, source.id).story.id;
    addVote({ feedId: feed.id, storyId: story, reason, userId: "me" });
    const result = await list(feed.id);
    expect(ids(result)).toEqual([story]);
    expect(result.stories[0]?.myVote).toBe(reason);
  });

  it("keeps the stored hidden reason over my_vote", async () => {
    const { feed, source } = feedWithSource();
    const story = judgedStory(feed.id, source.id, { judgement: { hiddenReason: "exclusion" } }).story.id;
    addVote({ feedId: feed.id, storyId: story, reason: "off_topic", userId: "me" });
    expect((await list(feed.id, { filtered: true })).stories[0]?.hidden).toBe("exclusion");
  });
});

describe("listFeedStories: topic filter", () => {
  it("keeps the stories whose judgement has the topic; the counts stay those of the window", async () => {
    const { feed, source } = feedWithSource();
    const agents = makeTopic({ name: "Coding agents" });
    const evals = makeTopic({ name: "Evaluations" });
    const a = judgedStory(feed.id, source.id, { judgement: { topicIds: [agents.id] } }).story.id;
    const b = judgedStory(feed.id, source.id, { judgement: { topicIds: [agents.id, evals.id] } }).story.id;
    judgedStory(feed.id, source.id, { judgement: { topicIds: [evals.id] } });

    const result = await list(feed.id, { topicSlug: agents.slug });
    expect(new Set(ids(result))).toEqual(new Set([a, b]));
    expect(result.visibleCount).toBe(3);
  });

  it("returns no story for an unknown or archived topic", async () => {
    const { feed, source } = feedWithSource();
    const archived = makeTopic({ archivedAt: NOW });
    judgedStory(feed.id, source.id, { judgement: { topicIds: [archived.id] } });
    expect((await list(feed.id, { topicSlug: "nothing-like-this" })).stories).toEqual([]);
    expect((await list(feed.id, { topicSlug: archived.slug })).stories).toEqual([]);
  });
});

describe("listFeedStories: order (§8.3)", () => {
  it("sorts 'top' by the decayed score with the half-life of the window", async () => {
    const { feed, source } = feedWithSource({ halfLifeHours: 24 });
    const old = judgedStory(feed.id, source.id, { ageHours: 20, base: 80 }).story.id;
    const fresh = judgedStory(feed.id, source.id, { ageHours: 0, base: 60 }).story.id;

    // today: half-life 24 h: 80 × 0.5^(20/24) ≈ 45 < 60.
    expect(ids(await list(feed.id, { window: "today" }))).toEqual([fresh, old]);
    // week: half-life 72 h: 80 × 0.5^(20/72) ≈ 66 > 60.
    const week = await list(feed.id, { window: "week" });
    expect(ids(week)).toEqual([old, fresh]);
    const card = week.stories[0]!;
    expect(card.decay.halfLifeHours).toBe(72);
    expect(card.decay.ageHours).toBeCloseTo(20, 5);
    expect(card.decay.factor).toBeCloseTo(Math.pow(0.5, 20 / 72), 10);
    expect(card.score).toBeCloseTo(80 * Math.pow(0.5, 20 / 72), 10);
    expect(card.baseScore).toBe(80);
  });

  it("uses ×10 of the half-life for the month", async () => {
    const { feed, source } = feedWithSource({ halfLifeHours: 10 });
    const result = await list(feed.id, { window: "month" });
    expect(result.stories).toEqual([]);
    judgedStory(feed.id, source.id, { ageHours: 100, base: 50 });
    const card = (await list(feed.id, { window: "month" })).stories[0]!;
    expect(card.decay.halfLifeHours).toBe(100);
    expect(card.score).toBeCloseTo(25, 10);
  });

  it("sorts 'new' by fresh_at, whatever the score", async () => {
    const { feed, source } = feedWithSource();
    const strongOld = judgedStory(feed.id, source.id, { ageHours: 30, base: 99 }).story.id;
    const weakNew = judgedStory(feed.id, source.id, { ageHours: 1, base: 1 }).story.id;
    expect(ids(await list(feed.id, { sort: "new" }))).toEqual([weakNew, strongOld]);
    expect(ids(await list(feed.id, { sort: "top" }))).toEqual([strongOld, weakNew]);
  });

  it("breaks score ties by fresh_at, then by id (newest first)", async () => {
    const { feed, source } = feedWithSource();
    const older = judgedStory(feed.id, source.id, { ageHours: 5, base: 0 }).story.id;
    const newer = judgedStory(feed.id, source.id, { ageHours: 2, base: 0 }).story.id;
    const twinA = judgedStory(feed.id, source.id, { ageHours: 3, base: 50 }).story.id;
    const twinB = judgedStory(feed.id, source.id, { ageHours: 3, base: 50 }).story.id;
    expect(ids(await list(feed.id))).toEqual([twinB, twinA, newer, older]);
  });
});

describe("listFeedStories: limit", () => {
  it("cuts to the limit and says when more exist", async () => {
    const { feed, source } = feedWithSource();
    for (let i = 0; i < 5; i += 1) judgedStory(feed.id, source.id, { base: 50 + i });
    const two = await list(feed.id, { limit: 2 });
    expect(two.stories).toHaveLength(2);
    expect(two.hasMore).toBe(true);
    expect(two.visibleCount).toBe(5);
    const all = await list(feed.id, { limit: 5 });
    expect(all.stories).toHaveLength(5);
    expect(all.hasMore).toBe(false);
  });

  it("uses 50 as the default limit", async () => {
    const { feed, source } = feedWithSource();
    for (let i = 0; i < 51; i += 1) judgedStory(feed.id, source.id);
    const result = await list(feed.id);
    expect(result.stories).toHaveLength(50);
    expect(result.hasMore).toBe(true);
  });
});

describe("listFeedStories: query count", () => {
  it("uses the same number of queries for 3 and for 60 stories", async () => {
    const countQueries = async (n: number) => {
      const { feed, source } = feedWithSource();
      for (let i = 0; i < n; i += 1) {
        const { story } = judgedStory(feed.id, source.id);
        addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
      }
      const spy = vi.spyOn(t.sqlite, "prepare");
      await list(feed.id, { limit: 100 });
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };
    const few = await countQueries(3);
    expect(await countQueries(60)).toBe(few);
    expect(few).toBeGreaterThan(0);
    expect(few).toBeLessThanOrEqual(12);
  });
});

describe("listFeedStories: card fields", () => {
  const FIVE = ["One.", "Two.", "Three.", "Four.", "Five."];

  it("cuts the summary to 1 / 3 / 5 sentences for short / standard / detailed", async () => {
    for (const [length, count] of [["short", 1], ["standard", 3], ["detailed", 5]] as const) {
      const { feed, source } = feedWithSource({ briefFormat: { summaryLength: length, technicalDepth: null, suggestedActions: null } });
      judgedStory(feed.id, source.id, { story: { summary: FIVE } });
      expect((await list(feed.id)).stories[0]?.summary).toEqual(FIVE.slice(0, count));
    }
  });

  it("uses the shared default summary length when the feed has none", async () => {
    getSqlite()
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('brief_defaults', ?, ?)")
      .run(JSON.stringify({ summaryLength: "short", technicalDepth: "practitioner", suggestedActions: true }), NOW);
    const { feed, source } = feedWithSource();
    judgedStory(feed.id, source.id, { story: { summary: FIVE } });
    expect((await list(feed.id)).stories[0]?.summary).toEqual(["One."]);
  });

  it("shows the suggested action only when the feed has suggested actions on", async () => {
    const on = feedWithSource();
    judgedStory(on.feed.id, on.source.id, { judgement: { suggestedAction: "Try it." } });
    expect((await list(on.feed.id)).stories[0]?.suggestedAction).toBe("Try it.");

    const off = feedWithSource({ briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: false } });
    judgedStory(off.feed.id, off.source.id, { judgement: { suggestedAction: "Try it." } });
    expect((await list(off.feed.id)).stories[0]?.suggestedAction).toBeNull();
  });

  it("reads the basis from the primary item's meta.basis", async () => {
    const { feed, source } = feedWithSource();
    const notes = judgedStory(feed.id, source.id, { item: { kind: "episode", meta: { basis: "show_notes" } } }).story.id;
    const plain = judgedStory(feed.id, source.id).story.id;
    const cards = new Map((await list(feed.id)).stories.map((card) => [card.storyId, card]));
    expect(cards.get(notes)?.basis).toBe("show_notes");
    expect(cards.get(plain)?.basis).toBeNull();
  });

  it("lists only the topics that exist and are not archived", async () => {
    const { feed, source } = feedWithSource();
    const active = makeTopic({ name: "Agents" });
    const archived = makeTopic({ name: "Old", archivedAt: NOW });
    judgedStory(feed.id, source.id, { judgement: { topicIds: [archived.id, active.id, 9999] } });
    expect((await list(feed.id)).stories[0]?.topics).toEqual([{ id: active.id, slug: active.slug, name: "Agents" }]);
  });

  it("lists the distinct sources of the story, the sources of the feed first", async () => {
    const { feed, source } = feedWithSource();
    const outside = makeSource({ name: "Outside", type: "community", config: { variant: "hn", query: "agents" } });
    const { story } = judgedStory(feed.id, source.id, { ageHours: 1 });
    makeItem({ sourceId: outside.id, storyId: story.id, publishedAt: NOW - 10 * HOUR_MS });
    makeItem({ sourceId: outside.id, storyId: story.id, publishedAt: NOW - 9 * HOUR_MS });
    makeItem({ sourceId: source.id, storyId: story.id });
    const card = (await list(feed.id)).stories[0]!;
    expect(card.sources).toEqual([
      { id: source.id, name: source.name, type: "blog" },
      { id: outside.id, name: "Outside", type: "community" },
    ]);
  });

  it("returns the story facts, the judgement facts, the votes, and the analysis status", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id, {
      base: 70,
      story: { headline: "A release", category: "security", itemCount: 3, sourceCount: 2 },
      judgement: {
        relevance: 82,
        reason: "It changes our tool.",
        whyItMatters: "We use it.",
        novelty: "update",
        depth: "advanced",
        exclusion: null,
        rankParts: [{ key: "relevance", label: "Relevance", value: 82 }],
      },
    });
    addVote({ feedId: feed.id, storyId: story.id, reason: "useful", userId: "me" });
    addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: story.id, reason: "already_knew" });
    getSqlite()
      .prepare("INSERT INTO analyses (feed_id, story_id, status, requested_by, requested_at, updated_at) VALUES (?, ?, 'running', 'A', ?, ?)")
      .run(feed.id, story.id, NOW, NOW);

    const card = (await list(feed.id)).stories[0]!;
    expect(card).toMatchObject({
      storyId: story.id,
      headline: "A release",
      category: "security",
      primaryUrl: story.primaryUrl,
      itemCount: 3,
      sourceCount: 2,
      freshAt: story.freshAt,
      relevance: 82,
      reason: "It changes our tool.",
      whyItMatters: "We use it.",
      novelty: "update",
      depth: "advanced",
      baseScore: 70,
      rankParts: [{ key: "relevance", label: "Relevance", value: 82 }],
      hidden: null,
      exclusion: null,
      votes: { useful: 2, too_basic: 0, off_topic: 0, already_knew: 1 },
      myVote: "useful",
      analysisStatus: "running",
    });
    const other = judgedStory(feed.id, source.id).story.id;
    expect((await list(feed.id)).stories.find((c) => c.storyId === other)?.analysisStatus).toBe("none");
  });
});

describe("listFeedStories: alerts (§9.3)", () => {
  const alertsOn = { enabled: true, rule: "Breaking changes", minRelevance: 85 };

  it("shows an alert that is visible now and at most 72 h old, for every browser", async () => {
    const { feed, source } = feedWithSource({ alerts: alertsOn });
    const story = judgedStory(feed.id, source.id).story.id;
    const alertId = addAlert(feed.id, story, NOW - HOUR_MS);
    expect((await list(feed.id)).stories[0]?.alert).toEqual({ id: alertId });
    // Dismissal is client-side only: another browser gets the same alert.
    expect((await list(feed.id, { userId: "another" })).stories[0]?.alert).toEqual({ id: alertId });
  });

  it("does not show an alert whose visible_at is in the future (quiet hours) or older than 72 h", async () => {
    const { feed, source } = feedWithSource({ alerts: alertsOn });
    const later = judgedStory(feed.id, source.id).story.id;
    const stale = judgedStory(feed.id, source.id).story.id;
    const edge = judgedStory(feed.id, source.id).story.id;
    addAlert(feed.id, later, NOW + HOUR_MS);
    addAlert(feed.id, stale, NOW - 73 * HOUR_MS);
    addAlert(feed.id, edge, NOW - 72 * HOUR_MS);
    const cards = new Map((await list(feed.id)).stories.map((card) => [card.storyId, card]));
    expect(cards.get(later)?.alert).toBeNull();
    expect(cards.get(stale)?.alert).toBeNull();
    expect(cards.get(edge)?.alert).not.toBeNull();
  });

  it("does not show an alert when alerts are off for the feed", async () => {
    const { feed, source } = feedWithSource();
    const story = judgedStory(feed.id, source.id).story.id;
    addAlert(feed.id, story, NOW - HOUR_MS);
    expect((await list(feed.id)).stories[0]?.alert).toBeNull();
  });

  it("does not show an alert on a hidden story (also hidden by my own vote)", async () => {
    const { feed, source } = feedWithSource({ alerts: alertsOn });
    const hidden = judgedStory(feed.id, source.id, { judgement: { hiddenReason: "feedback" } }).story.id;
    const mine = judgedStory(feed.id, source.id).story.id;
    addAlert(feed.id, hidden, NOW - HOUR_MS);
    addAlert(feed.id, mine, NOW - HOUR_MS);
    addVote({ feedId: feed.id, storyId: mine, reason: "off_topic", userId: "me" });
    const filtered = await list(feed.id, { filtered: true });
    expect(filtered.stories.map((card) => card.alert)).toEqual([null, null]);
  });
});

describe("listFeedStories: queue facts", () => {
  it("counts the pending items of this feed's sources only", async () => {
    const { feed, source } = feedWithSource();
    const other = makeSource();
    makeItem({ sourceId: source.id });
    makeItem({ sourceId: source.id });
    makeItem({ sourceId: source.id, judgeStatus: "failed" });
    makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "too_old" });
    makeItem({ sourceId: other.id });
    expect((await list(feed.id)).pendingItems).toBe(2);
  });

  it("reports the newest open re-judge request as the backfill progress", async () => {
    const { feed } = feedWithSource();
    const insert = getSqlite().prepare(
      `INSERT INTO rejudge_requests (feed_id, since_at, status, total, done, requested_by, requested_at, updated_at)
       VALUES (?, 0, ?, ?, ?, 'T', ?, ?)`,
    );
    insert.run(feed.id, "done", 9, 9, NOW - 3 * HOUR_MS, NOW);
    expect((await list(feed.id)).backfill).toBeNull();
    insert.run(feed.id, "queued", 8, 0, NOW - 2 * HOUR_MS, NOW);
    insert.run(feed.id, "running", 5, 2, NOW - HOUR_MS, NOW);
    expect((await list(feed.id)).backfill).toEqual({ done: 2, total: 5, kind: "rejudge" });
  });

  it("calls an open request with a source a backfill, and one without a source a re-judge", async () => {
    const { feed, source } = feedWithSource();
    const insert = getSqlite().prepare(
      `INSERT INTO rejudge_requests (feed_id, source_id, since_at, status, total, done, requested_by, requested_at, updated_at)
       VALUES (?, ?, 0, 'queued', 4, 1, 'T', ?, ?)`,
    );
    insert.run(feed.id, source.id, NOW - HOUR_MS, NOW);
    expect((await list(feed.id)).backfill).toEqual({ done: 1, total: 4, kind: "backfill" });
    insert.run(feed.id, null, NOW, NOW);
    expect((await list(feed.id)).backfill).toEqual({ done: 1, total: 4, kind: "rejudge" });
  });

  it("reports the newest last check of the feed's sources", async () => {
    const { feed, source } = feedWithSource();
    expect((await list(feed.id)).lastCheckAt).toBeNull();
    const second = makeSource({ lastCheckedAt: NOW - HOUR_MS });
    linkFeedSource(feed.id, second.id);
    makeSource({ lastCheckedAt: NOW });
    getSqlite().prepare("UPDATE sources SET last_checked_at = ? WHERE id = ?").run(NOW - 5 * HOUR_MS, source.id);
    expect((await list(feed.id)).lastCheckAt).toBe(NOW - HOUR_MS);
  });
});

describe("getStory", () => {
  it("returns the card with the full summary, also when the story is hidden", async () => {
    const { feed, source } = feedWithSource({ briefFormat: { summaryLength: "short", technicalDepth: null, suggestedActions: null } });
    const { story } = judgedStory(feed.id, source.id, {
      story: { summary: ["One.", "Two.", "Three.", "Four."] },
      judgement: { hiddenReason: "below_threshold" },
    });
    const detail = await getStory(feed.id, story.id, "me");
    expect(detail?.card.summary).toEqual(["One.", "Two.", "Three.", "Four."]);
    expect(detail?.card.hidden).toBe("below_threshold");
    expect(detail?.card.decay.halfLifeHours).toBe(feed.halfLifeHours * 3);
  });

  it("shows my_vote for the browser that voted it down", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    addVote({ feedId: feed.id, storyId: story.id, reason: "too_basic", userId: "me" });
    expect((await getStory(feed.id, story.id, "me"))?.card).toMatchObject({ hidden: "my_vote", myVote: "too_basic" });
    expect((await getStory(feed.id, story.id, "other"))?.card.hidden).toBeNull();
  });

  it("returns null when the feed has no judgement for the story", async () => {
    const { feed, source } = feedWithSource();
    const other = makeFeed();
    const { story } = judgedStory(other.id, source.id);
    expect(await getStory(feed.id, story.id, "me")).toBeNull();
    expect(await getStory(999, story.id, "me")).toBeNull();
  });

  it("keeps the text of short kinds (cut to 2000 characters) and gives '' for long kinds", async () => {
    const { feed, source } = feedWithSource();
    const { story, item } = judgedStory(feed.id, source.id, { item: { kind: "article", contentText: "A long article." } });
    const post = makeItem({ sourceId: source.id, storyId: story.id, kind: "post", contentText: "x".repeat(2500) });
    const thread = makeItem({ sourceId: source.id, storyId: story.id, kind: "discussion", contentText: "A thread." });
    const detail = await getStory(feed.id, story.id, "me");
    const rows = new Map(detail!.items.map((row) => [row.id, row]));
    expect(rows.get(item.id)?.text).toBe("");
    expect(rows.get(post.id)?.text).toHaveLength(2000);
    expect(rows.get(thread.id)?.text).toBe("A thread.");
    expect(rows.get(item.id)).toMatchObject({ sourceId: source.id, sourceName: source.name, sourceType: "blog", kind: "article" });
  });

  it("lists the other active feeds where the story is visible", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    const visible = makeFeed({ name: "Radar" });
    const hidden = makeFeed({ name: "Hidden" });
    const archived = makeFeed({ name: "Archived", archivedAt: NOW });
    makeJudgement({ feedId: visible.id, storyId: story.id });
    makeJudgement({ feedId: hidden.id, storyId: story.id, hiddenReason: "feedback" });
    makeJudgement({ feedId: archived.id, storyId: story.id });
    expect((await getStory(feed.id, story.id, "me"))?.otherFeeds).toEqual([{ slug: visible.slug, name: "Radar" }]);
  });

  it("returns the analysis view and empties its actions when the feed has suggested actions off", async () => {
    const off = feedWithSource({ briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: false } });
    const { story } = judgedStory(off.feed.id, off.source.id);
    expect((await getStory(off.feed.id, story.id, "me"))?.analysis).toBeNull();
    const content = {
      whatChanged: ["A."],
      howItWorks: [],
      whatItMeansForUs: ["B."],
      risksAndLimits: [],
      suggestedActions: [{ action: "Try", why: "Because", effort: "quick_check", firstStep: "Read" }],
      openQuestions: [],
      confidence: "medium",
      confidenceNote: "",
      sourcesUsed: [],
    };
    getSqlite()
      .prepare(
        `INSERT INTO analyses (feed_id, story_id, status, content, model, requested_by, requested_at, updated_at, finished_at)
         VALUES (?, ?, 'done', ?, 'glm', 'Dana', ?, ?, ?)`,
      )
      .run(off.feed.id, story.id, JSON.stringify(content), NOW - HOUR_MS, NOW, NOW);
    const analysis = (await getStory(off.feed.id, story.id, "me"))?.analysis;
    expect(analysis).toMatchObject({ status: "done", model: "glm", requestedBy: "Dana", finishedAt: NOW });
    expect(analysis?.content?.whatChanged).toEqual(["A."]);
    expect(analysis?.content?.suggestedActions).toEqual([]);
  });
});
