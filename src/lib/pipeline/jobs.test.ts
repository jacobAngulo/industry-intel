import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backfillFeedSource,
  clearLlmPause,
  createRejudgeRequest,
  estimateRejudgeCount,
  isWorkerAlive,
  modelGate,
  orphanStoryIds,
  readHeartbeat,
  readLlmPause,
  refreshStories,
  rejudgeWorkStoryIds,
  setLlmPause,
  writeWorkerState,
} from "@/lib/pipeline/jobs";
import { DAY_MS, HOUR_MS, nextUtcMidnight } from "@/lib/time";
import {
  addVote,
  createEnv,
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

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});

afterEach(() => {
  t.cleanup();
});

describe("worker state", () => {
  it("reads the heartbeat and tells if the worker is alive", () => {
    expect(readHeartbeat()).toBeNull();
    expect(isWorkerAlive(NOW)).toBe(false);
    writeWorkerState("heartbeat", { at: NOW - 10_000, hasModelKey: true, hasXToken: false, hasMailbox: false }, NOW);
    expect(readHeartbeat()?.hasModelKey).toBe(true);
    expect(isWorkerAlive(NOW)).toBe(true);
    expect(isWorkerAlive(NOW + 25_000)).toBe(false);
  });

  it("stores and clears the model pause", () => {
    expect(readLlmPause()).toEqual({ pausedUntil: null, step: 0, lastError: null });
    setLlmPause({ until: NOW + 10 * 60_000, step: 2, lastError: "The model service is busy." }, NOW);
    expect(readLlmPause()).toEqual({ pausedUntil: NOW + 10 * 60_000, step: 2, lastError: "The model service is busy." });
    clearLlmPause(NOW);
    expect(readLlmPause()).toEqual({ pausedUntil: null, step: 0, lastError: null });
  });
});

describe("modelGate", () => {
  const withKey = createEnv({ OLLAMA_API_KEY: "test-key", LLM_MAX_CALLS_PER_DAY: "3" });

  it("is closed with no key", () => {
    expect(modelGate(NOW, createEnv({}))).toEqual({ open: false, reason: "no_key" });
  });

  it("is open with a key, no pause, and calls left", () => {
    expect(modelGate(NOW, withKey)).toEqual({ open: true });
  });

  it("is closed while the model is paused, and open after the pause", () => {
    setLlmPause({ until: NOW + 60_000, step: 1, lastError: "busy" }, NOW);
    expect(modelGate(NOW, withKey)).toEqual({ open: false, reason: "paused", until: NOW + 60_000 });
    expect(modelGate(NOW + 60_001, withKey)).toEqual({ open: true });
  });

  it("is closed when the daily call limit is used", () => {
    t.sqlite.prepare("INSERT INTO usage_daily (day, metric, value) VALUES (?, 'llm_calls', 3)").run("2026-11-20");
    expect(modelGate(NOW, withKey)).toEqual({ open: false, reason: "budget", until: nextUtcMidnight(NOW) });
  });
});

describe("re-judge work list", () => {
  function setup() {
    const feed = makeFeed();
    const a = makeSource();
    const b = makeSource();
    const outside = makeSource();
    linkFeedSource(feed.id, a.id);
    linkFeedSource(feed.id, b.id);
    return { feed, a, b, outside };
  }

  it("lists the stories of the feed's sources in the period that need a new judgement, newest first", () => {
    const { feed, a, b, outside } = setup();
    const oldJudged = makeStory();
    makeItem({ sourceId: a.id, storyId: oldJudged.id, fetchedAt: NOW - 2 * DAY_MS });
    makeJudgement({ feedId: feed.id, storyId: oldJudged.id, judgedAt: NOW - 3 * DAY_MS });

    const fresh = makeStory();
    makeItem({ sourceId: a.id, storyId: fresh.id, fetchedAt: NOW - 1 * DAY_MS });
    makeJudgement({ feedId: feed.id, storyId: fresh.id, judgedAt: NOW + 1000 });

    const tooOld = makeStory();
    makeItem({ sourceId: a.id, storyId: tooOld.id, fetchedAt: NOW - 10 * DAY_MS });

    const notInFeed = makeStory();
    makeItem({ sourceId: outside.id, storyId: notInFeed.id, fetchedAt: NOW - DAY_MS });

    const unjudged = makeStory();
    makeItem({ sourceId: b.id, storyId: unjudged.id, fetchedAt: NOW - 1000 });

    const scope = { feedId: feed.id, sourceId: null, sinceAt: NOW - 7 * DAY_MS, requestedAt: NOW };
    expect(rejudgeWorkStoryIds(scope)).toEqual([unjudged.id, oldJudged.id]);
    expect(rejudgeWorkStoryIds({ ...scope, sourceId: a.id })).toEqual([oldJudged.id]);
    expect(rejudgeWorkStoryIds(scope, 10, [unjudged.id])).toEqual([oldJudged.id]);
    expect(rejudgeWorkStoryIds(scope, 1)).toEqual([unjudged.id]);
    expect(estimateRejudgeCount(feed.id)).toBe(2);
    expect(estimateRejudgeCount(feed.id, { maxStories: 1 })).toBe(1);
  });

  it("creates one open request for a feed and source, and refreshes it on a second call", () => {
    const { feed, a } = setup();
    const story = makeStory();
    makeItem({ sourceId: a.id, storyId: story.id, fetchedAt: NOW - HOUR_MS });
    makeJudgement({ feedId: feed.id, storyId: story.id, judgedAt: NOW - HOUR_MS });

    const first = createRejudgeRequest({ feedId: feed.id, requestedBy: "Ana", now: NOW });
    expect(first.created).toBe(true);
    expect(first.request).toMatchObject({ status: "queued", total: 1, done: 0, sourceId: null, requestedBy: "Ana" });

    const second = createRejudgeRequest({ feedId: feed.id, requestedBy: "Ben", now: NOW + 5000 });
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(second.request.requestedAt).toBe(NOW + 5000);

    // A request for one source is a different request.
    const perSource = createRejudgeRequest({ feedId: feed.id, sourceId: a.id, requestedBy: "Ana", now: NOW });
    expect(perSource.created).toBe(true);
    expect(perSource.request.id).not.toBe(first.request.id);
  });

  it("stores a request with no work as done", () => {
    const { feed } = setup();
    const result = createRejudgeRequest({ feedId: feed.id, requestedBy: "Ana", now: NOW });
    expect(result.request).toMatchObject({ status: "done", total: 0, finishedAt: NOW });
  });
});

describe("backfillFeedSource", () => {
  it("queues the newest no_feed items of the last 7 days and the recent stories of the source", () => {
    const feed = makeFeed();
    const source = makeSource();
    // Eleven no_feed items in the period, one too old, one with another skip reason.
    const recent = Array.from({ length: 11 }, (_, i) =>
      makeItem({
        sourceId: source.id,
        judgeStatus: "skipped",
        skipReason: "no_feed",
        fetchedAt: NOW - (i + 1) * HOUR_MS,
        publishedAt: NOW - (i + 1) * HOUR_MS,
      }),
    );
    const old = makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "no_feed", fetchedAt: NOW - 9 * DAY_MS });
    const capped = makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "first_run_cap", fetchedAt: NOW - HOUR_MS });
    // One story from the source that the feed never judged.
    const story = makeStory();
    makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - 2 * HOUR_MS });

    linkFeedSource(feed.id, source.id);
    const result = backfillFeedSource({ feedId: feed.id, sourceId: source.id, requestedBy: "Ana", now: NOW });

    expect(result.queuedItems).toBe(8);
    expect(result.queuedStories).toBe(1);
    expect(result.requestId).not.toBeNull();

    const status = (id: number) =>
      (t.sqlite.prepare("SELECT judge_status AS s, skip_reason AS r FROM items WHERE id = ?").get(id) as { s: string; r: string | null });
    expect(recent.slice(0, 8).map((item) => status(item.id).s)).toEqual(Array(8).fill("pending"));
    expect(recent.slice(8).map((item) => status(item.id).s)).toEqual(["skipped", "skipped", "skipped"]);
    expect(status(old.id)).toEqual({ s: "skipped", r: "no_feed" });
    expect(status(capped.id)).toEqual({ s: "skipped", r: "first_run_cap" });
  });

  it("does nothing for an archived feed and queues no request when there is no story", () => {
    const archived = makeFeed({ archivedAt: NOW - DAY_MS });
    const source = makeSource();
    makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "no_feed", fetchedAt: NOW - HOUR_MS });
    expect(backfillFeedSource({ feedId: archived.id, sourceId: source.id, requestedBy: "Ana", now: NOW })).toEqual({
      queuedItems: 0,
      queuedStories: 0,
      requestId: null,
    });

    const active = makeFeed();
    linkFeedSource(active.id, source.id);
    const result = backfillFeedSource({ feedId: active.id, sourceId: source.id, requestedBy: "Ana", now: NOW });
    expect(result).toEqual({ queuedItems: 1, queuedStories: 0, requestId: null });
  });
});

describe("refreshStories", () => {
  it("recomputes the counts and the primary item, and deletes the stories with no item", () => {
    const feed = makeFeed();
    const blog = makeSource();
    const forum = makeSource();
    linkFeedSource(feed.id, blog.id);
    linkFeedSource(feed.id, forum.id);

    const shared = makeStory({ itemCount: 2, sourceCount: 2 });
    const first = makeItem({ sourceId: forum.id, storyId: shared.id, publishedAt: NOW - 3 * HOUR_MS, url: "https://forum.example/t/1" });
    const second = makeItem({ sourceId: blog.id, storyId: shared.id, publishedAt: NOW - 2 * HOUR_MS, url: "https://blog.example/post" });
    t.sqlite.prepare("UPDATE stories SET primary_item_id = ?, primary_url = ? WHERE id = ?").run(first.id, first.url, shared.id);
    makeJudgement({ feedId: feed.id, storyId: shared.id });
    addVote({ feedId: feed.id, storyId: shared.id, reason: "useful" });

    const lonely = makeStory();
    makeItem({ sourceId: forum.id, storyId: lonely.id });
    makeJudgement({ feedId: feed.id, storyId: lonely.id });

    // Delete the forum source: its items go by cascade.
    t.sqlite.prepare("DELETE FROM sources WHERE id = ?").run(forum.id);
    expect(orphanStoryIds()).toEqual([lonely.id]);

    const result = refreshStories([shared.id, lonely.id], NOW);
    expect(result).toEqual({ updated: [shared.id], deleted: [lonely.id] });

    const row = t.sqlite
      .prepare("SELECT item_count AS n, source_count AS s, primary_item_id AS p, primary_url AS u, last_item_at AS l FROM stories WHERE id = ?")
      .get(shared.id) as { n: number; s: number; p: number; u: string; l: number };
    expect(row).toEqual({ n: 1, s: 1, p: second.id, u: "https://blog.example/post", l: NOW - 2 * HOUR_MS });
    expect(t.sqlite.prepare("SELECT COUNT(*) AS c FROM stories WHERE id = ?").get(lonely.id)).toEqual({ c: 0 });
    expect(t.sqlite.prepare("SELECT COUNT(*) AS c FROM stories_fts WHERE rowid = ?").get(lonely.id)).toEqual({ c: 0 });
    expect(t.sqlite.prepare("SELECT COUNT(*) AS c FROM judgements WHERE story_id = ?").get(lonely.id)).toEqual({ c: 0 });
    // The judgement of the story that stays got a fresh rank.
    const judgement = t.sqlite.prepare("SELECT hidden_reason AS h FROM judgements WHERE story_id = ?").get(shared.id) as { h: string | null };
    expect(judgement.h).toBeNull();
  });

  it("does nothing for an empty list", () => {
    expect(refreshStories([])).toEqual({ updated: [], deleted: [] });
  });
});
