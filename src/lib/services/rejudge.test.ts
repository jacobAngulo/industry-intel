import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activity, rejudgeRequests } from "@/lib/db/schema";
import { HOUR_MS } from "@/lib/time";
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

import { ServiceError } from "./_manage-errors";
import { estimateRejudge, rejudgeProgress, requestRejudge } from "./rejudge";

const NOW = 1_800_000_000_000;
const actor = { name: "Dana", clientId: "c1" };

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

async function expectCode(promise: Promise<unknown>, code: ServiceError["code"]): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
}

/** A feed with two sources and three judged stories (two of source A). */
function setup() {
  const feed = makeFeed();
  const a = makeSource();
  const b = makeSource();
  linkFeedSource(feed.id, a.id);
  linkFeedSource(feed.id, b.id);
  for (const source of [a, a, b]) {
    const story = makeStory();
    makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - HOUR_MS });
    makeJudgement({ feedId: feed.id, storyId: story.id, judgedAt: NOW - HOUR_MS });
  }
  return { feed, a, b };
}

describe("estimateRejudge", () => {
  it("counts the work list: all sources of the feed, or one source", async () => {
    const { feed, a } = setup();
    expect(await estimateRejudge(feed.id)).toBe(3);
    expect(await estimateRejudge(feed.id, { sourceId: a.id })).toBe(2);
    expect(await estimateRejudge(999)).toBe(0);
  });
});

describe("requestRejudge and rejudgeProgress", () => {
  it("creates a request with an activity row, then returns the open one", async () => {
    const { feed, a } = setup();
    expect(await rejudgeProgress(feed.id)).toBeNull();

    const first = await requestRejudge(feed.id, {}, actor);
    expect(first).toEqual({ id: first.id, feedId: feed.id, status: "queued", total: 3, done: 0, failed: 0 });
    expect(t.db.select().from(rejudgeRequests).get()).toMatchObject({ requestedBy: "Dana", sourceId: null });

    const again = await requestRejudge(feed.id, {}, actor);
    expect(again.id).toBe(first.id);
    const bySource = await requestRejudge(feed.id, { sourceId: a.id, maxStories: 1 }, actor);
    expect(bySource).toMatchObject({ total: 1 });
    expect(bySource.id).not.toBe(first.id);

    expect(t.db.select().from(activity).all().map((row) => [row.action, row.entityId])).toEqual([
      ["feed.rejudge", feed.id],
      ["feed.rejudge", feed.id],
      ["feed.rejudge", feed.id],
    ]);
    expect(await rejudgeProgress(feed.id)).toEqual(bySource);
  });

  it("maps the status and counts of the newest request", async () => {
    const { feed } = setup();
    const request = await requestRejudge(feed.id, {}, actor);
    t.db.update(rejudgeRequests).set({ status: "running", done: 2, failed: 1 }).run();
    expect(await rejudgeProgress(feed.id)).toEqual({ id: request.id, feedId: feed.id, status: "running", total: 3, done: 2, failed: 1 });
  });

  it("rejects an unknown feed or source, an archived feed, and bad numbers", async () => {
    const { feed } = setup();
    await expectCode(requestRejudge(999, {}, actor), "not_found");
    await expectCode(requestRejudge(feed.id, { sourceId: 999 }, actor), "not_found");
    await expectCode(requestRejudge(feed.id, { maxStories: 0 }, actor), "validation");
    await expectCode(requestRejudge(feed.id, {}, { name: "", clientId: "c" }), "needs_name");
    const archived = makeFeed({ archivedAt: NOW });
    await expectCode(requestRejudge(archived.id, {}, actor), "conflict");
    expect(t.db.select().from(rejudgeRequests).all()).toEqual([]);
  });
});
