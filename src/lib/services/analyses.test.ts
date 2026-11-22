import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSqlite } from "@/lib/db/client";
import { HOUR_MS } from "@/lib/time";
import { installTestDb, makeFeed, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { NOW, feedWithSource, judgedStory } from "./_read-testkit";
import { requestAnalysis } from "./analyses";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

const dana = { name: "Dana", userId: "c1" };
const CONTENT = {
  whatChanged: ["Old text."],
  howItWorks: [],
  whatItMeansForUs: [],
  risksAndLimits: [],
  suggestedActions: [{ action: "Try", why: "Because", effort: "quick_check", firstStep: "Read" }],
  openQuestions: [],
  confidence: "low",
  confidenceNote: "",
  sourcesUsed: [],
};

type Row = {
  status: string;
  stage: string | null;
  attempts: number;
  error: string | null;
  content: string | null;
  model: string | null;
  requestedBy: string;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

function rowOf(feedId: number, storyId: number): Row | undefined {
  return getSqlite()
    .prepare(
      `SELECT status, stage, attempts, error, content, model, requested_by AS requestedBy, requested_at AS requestedAt,
              started_at AS startedAt, finished_at AS finishedAt
         FROM analyses WHERE feed_id = ? AND story_id = ?`,
    )
    .get(feedId, storyId) as Row | undefined;
}

function insertRow(feedId: number, storyId: number, fields: { status: string; attempts?: number; error?: string | null }): void {
  getSqlite()
    .prepare(
      `INSERT INTO analyses (feed_id, story_id, status, stage, content, error, model, attempts, requested_by, requested_at,
                             started_at, updated_at, finished_at)
       VALUES (?, ?, ?, 'Writing', ?, ?, 'glm', ?, 'Earlier', ?, ?, ?, ?)`,
    )
    .run(
      feedId,
      storyId,
      fields.status,
      JSON.stringify(CONTENT),
      fields.error ?? null,
      fields.attempts ?? 1,
      NOW - 5 * HOUR_MS,
      NOW - 5 * HOUR_MS,
      NOW - 4 * HOUR_MS,
      NOW - 4 * HOUR_MS,
    );
}

describe("requestAnalysis", () => {
  it("needs a judgement of the story in the feed", async () => {
    const { feed, source } = feedWithSource();
    const other = makeFeed();
    const { story } = judgedStory(other.id, source.id);
    await expect(requestAnalysis(feed.id, story.id, dana)).rejects.toMatchObject({ code: "not_found" });
    await expect(requestAnalysis(999, story.id, dana)).rejects.toMatchObject({ code: "not_found" });
    expect(rowOf(feed.id, story.id)).toBeUndefined();
  });

  it("creates a queued row and returns its view", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    const view = await requestAnalysis(feed.id, story.id, dana);
    expect(view).toMatchObject({ status: "queued", stage: null, content: null, error: null, requestedBy: "Dana", requestedAt: NOW, finishedAt: null });
    expect(rowOf(feed.id, story.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it.each(["queued", "running"])("leaves a %s row as it is", async (status) => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    insertRow(feed.id, story.id, { status });
    const before = rowOf(feed.id, story.id);
    const view = await requestAnalysis(feed.id, story.id, dana);
    expect(rowOf(feed.id, story.id)).toEqual(before);
    expect(view.status).toBe(status);
    expect(view.requestedBy).toBe("Earlier");
  });

  it("puts a done row back to queued with attempts 0 and keeps the old content until the new one is written", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    insertRow(feed.id, story.id, { status: "done" });
    const view = await requestAnalysis(feed.id, story.id, dana);
    expect(rowOf(feed.id, story.id)).toMatchObject({
      status: "queued",
      stage: null,
      attempts: 0,
      error: null,
      model: "glm",
      requestedBy: "Dana",
      requestedAt: NOW,
      startedAt: null,
      finishedAt: null,
    });
    expect(view.content?.whatChanged).toEqual(["Old text."]);
  });

  it("puts a failed row back to queued with attempts 0 and no error", async () => {
    const { feed, source } = feedWithSource();
    const { story } = judgedStory(feed.id, source.id);
    insertRow(feed.id, story.id, { status: "failed", attempts: 3, error: "The model answer was not valid." });
    const view = await requestAnalysis(feed.id, story.id, dana);
    expect(view).toMatchObject({ status: "queued", error: null });
    expect(rowOf(feed.id, story.id)).toMatchObject({ status: "queued", attempts: 0, error: null });
  });

  it("hides the suggested actions of the view when the feed has them off", async () => {
    const { feed, source } = feedWithSource({ briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: false } });
    const { story } = judgedStory(feed.id, source.id);
    insertRow(feed.id, story.id, { status: "done" });
    expect((await requestAnalysis(feed.id, story.id, dana)).content?.suggestedActions).toEqual([]);
  });
});
