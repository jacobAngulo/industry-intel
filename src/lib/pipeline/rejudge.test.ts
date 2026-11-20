import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LlmError } from "@/lib/llm/types";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@/lib/time";
import {
  FakeHttp,
  FakeLlm,
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

import { singleReply } from "./__fixtures__/replies";
import { createRejudgeRequest, readLlmPause } from "./jobs";
import { forgetRejudgeFailures, runRejudgeStep } from "./rejudge";
import type { PipelineDeps } from "./types";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;
let clock: number;
let llm: FakeLlm;
let deps: PipelineDeps;

beforeEach(() => {
  t = installTestDb();
  clock = NOW;
  setNowForTests(() => clock);
  llm = new FakeLlm();
  deps = { llm, http: new FakeHttp(), search: null, mail: null, now: () => clock };
  forgetRejudgeFailures();
});

afterEach(() => {
  t.cleanup();
});

type RequestRow = { status: string; total: number; done: number; failed: number; started_at: number | null; finished_at: number | null };
const requestRow = (id: number) => t.sqlite.prepare("SELECT * FROM rejudge_requests WHERE id = ?").get(id) as RequestRow;
const judgementOf = (feedId: number, storyId: number) =>
  t.sqlite.prepare("SELECT * FROM judgements WHERE feed_id = ? AND story_id = ?").get(feedId, storyId) as
    | { relevance: number; created_at: number; judged_at: number; source_item_id: number }
    | undefined;

/** A feed with one source and `n` stories with old judgements; newest story first. */
function setup(n: number, feedOver: Parameters<typeof makeFeed>[0] = {}) {
  const feed = makeFeed(feedOver);
  const source = makeSource();
  linkFeedSource(feed.id, source.id);
  const stories = Array.from({ length: n }, (_, i) => {
    const story = makeStory({ headline: `Story ${i}` });
    makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - (i + 1) * HOUR_MS, contentText: "short" });
    makeJudgement({ feedId: feed.id, storyId: story.id, relevance: 50, createdAt: NOW - 2 * DAY_MS, judgedAt: NOW - 2 * DAY_MS });
    return story;
  });
  clock = NOW + 1000;
  const { request } = createRejudgeRequest({ feedId: feed.id, requestedBy: "Ana", now: clock });
  return { feed, source, stories, requestId: request.id };
}

describe("runRejudgeStep", () => {
  it("returns false when there is no open request", async () => {
    expect(await runRejudgeStep(deps)).toBe(false);
  });

  it("starts the request, re-judges one story at a time (newest first), and finishes", async () => {
    const { feed, stories, requestId, source } = setup(3);
    const longest = makeItem({ sourceId: source.id, storyId: stories[0]?.id, contentText: "a much longer text", fetchedAt: NOW - 3 * HOUR_MS });
    makeItem({ sourceId: makeSource().id, storyId: stories[0]?.id, contentText: "x".repeat(500) }); // not a source of the feed
    llm.setHandler(() => singleReply([feed.id], { relevance: 77 }));
    clock = NOW + 5000;

    expect(await runRejudgeStep(deps)).toBe(true);
    expect(requestRow(requestId)).toMatchObject({ status: "running", total: 3, done: 1, started_at: NOW + 5000 });
    const first = judgementOf(feed.id, stories[0]?.id ?? 0);
    expect(first).toMatchObject({ relevance: 77, created_at: NOW - 2 * DAY_MS, judged_at: NOW + 5000, source_item_id: longest.id });
    expect(llm.calls[0]?.user).toContain(`STORY #${stories[0]?.id}`);
    expect(llm.calls[0]?.system).toContain('Return only the "feeds" list');

    await runRejudgeStep(deps);
    await runRejudgeStep(deps);
    expect(requestRow(requestId)).toMatchObject({ status: "done", done: 3, finished_at: NOW + 5000 });
    expect(await runRejudgeStep(deps)).toBe(false);
    expect(llm.calls).toHaveLength(3);
  });

  it("keeps a request open that the web process extends during a running step", async () => {
    const { feed, requestId } = setup(3);
    let calls = 0;
    llm.setHandler(() => {
      calls += 1;
      if (calls === 3) {
        // A person clicks Re-judge again during the model call of step 3.
        clock += 1000;
        const extended = createRejudgeRequest({ feedId: feed.id, requestedBy: "Ana", now: clock });
        expect(extended).toMatchObject({ created: false, request: { total: 5 } });
      }
      return singleReply([feed.id]);
    });
    clock = NOW + 5000;
    for (let i = 0; i < 3; i += 1) await runRejudgeStep(deps);
    expect(requestRow(requestId)).toMatchObject({ status: "running", total: 5, done: 3 });

    await runRejudgeStep(deps);
    await runRejudgeStep(deps);
    expect(requestRow(requestId)).toMatchObject({ status: "done", total: 5, done: 5 });
    expect(await runRejudgeStep(deps)).toBe(false);
    expect(llm.calls).toHaveLength(5);
  });

  it("does not reopen a request that is no longer open", async () => {
    const { feed, requestId } = setup(1);
    llm.setHandler(() => {
      t.sqlite.prepare("UPDATE rejudge_requests SET status = 'failed' WHERE id = ?").run(requestId);
      return singleReply([feed.id]);
    });
    await runRejudgeStep(deps);
    expect(requestRow(requestId).status).toBe("failed");
  });

  it("stops at max_stories", async () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    for (let i = 0; i < 3; i += 1) {
      const story = makeStory();
      makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - (i + 1) * HOUR_MS });
    }
    clock = NOW + 1000;
    const { request } = createRejudgeRequest({ feedId: feed.id, maxStories: 2, requestedBy: "Ana", now: clock });
    llm.setHandler(() => singleReply([feed.id]));
    await runRejudgeStep(deps);
    expect(requestRow(request.id)).toMatchObject({ total: 2, done: 1, status: "running" });
    await runRejudgeStep(deps);
    expect(requestRow(request.id)).toMatchObject({ done: 2, status: "done" });
    expect(llm.calls).toHaveLength(2);
  });

  it("a story that fails 2 times counts as failed and is skipped; after a restart it can be tried again", async () => {
    const { feed, stories, requestId } = setup(2);
    llm.enqueue(new LlmError("bad_output", "bad"), new LlmError("bad_output", "bad"));
    await runRejudgeStep(deps);
    expect(requestRow(requestId)).toMatchObject({ failed: 0, done: 0 });
    await runRejudgeStep(deps);
    expect(requestRow(requestId)).toMatchObject({ failed: 1, done: 0 });

    llm.enqueue(singleReply([feed.id], { relevance: 61 }));
    await runRejudgeStep(deps);
    expect(judgementOf(feed.id, stories[1]?.id ?? 0)?.relevance).toBe(61);
    expect(llm.calls[2]?.user).toContain(`STORY #${stories[1]?.id}`);
    expect(requestRow(requestId)).toMatchObject({ status: "done", done: 1, failed: 1 });

    // A restart forgets the failures: a new request can try the story again.
    forgetRejudgeFailures();
    clock += 1000;
    const again = createRejudgeRequest({ feedId: feed.id, requestedBy: "Ana", now: clock }).request;
    llm.enqueue(singleReply([feed.id], { relevance: 64 }), singleReply([feed.id], { relevance: 64 }));
    await runRejudgeStep(deps);
    expect(llm.calls[3]?.user).toContain(`STORY #${stories[0]?.id}`);
    expect(again.id).toBeGreaterThan(requestId);
  });

  it("a service error pauses the model and is not a failure of the story", async () => {
    const { requestId } = setup(1);
    llm.enqueue(new LlmError("overloaded", "busy"));
    await runRejudgeStep(deps);
    expect(requestRow(requestId)).toMatchObject({ failed: 0, done: 0, status: "running" });
    expect(readLlmPause().pausedUntil).toBe(clock + 2 * MINUTE_MS);
  });

  it("never creates an alert", async () => {
    const { feed, requestId } = setup(1, { alerts: { enabled: true, rule: "Anything", minRelevance: 50 } });
    llm.enqueue(singleReply([feed.id], { relevance: 99, alert: true }));
    await runRejudgeStep(deps);
    expect(requestRow(requestId).done).toBe(1);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({ n: 0 });
  });

  it("inserts a judgement for a story that had none", async () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const story = makeStory();
    makeItem({ sourceId: source.id, storyId: story.id });
    clock = NOW + 1000;
    createRejudgeRequest({ feedId: feed.id, requestedBy: "Ana", now: clock });
    llm.enqueue(singleReply([feed.id], { relevance: 70 }));
    await runRejudgeStep(deps);
    expect(judgementOf(feed.id, story.id)).toMatchObject({ relevance: 70, created_at: clock, judged_at: clock });
  });

  it("finishes the request of an archived feed with no model call", async () => {
    const { feed, requestId } = setup(2);
    t.sqlite.prepare("UPDATE feeds SET archived_at = ? WHERE id = ?").run(NOW, feed.id);
    expect(await runRejudgeStep(deps)).toBe(true);
    expect(requestRow(requestId).status).toBe("done");
    expect(llm.calls).toHaveLength(0);
  });
});
