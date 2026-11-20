import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MINUTE_MS } from "@/lib/time";
import { installTestDb, makeFeed, makeItem, makeSource, makeStory, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { housekeeping } from "./housekeeping";
import { setLlmPause } from "./jobs";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});

afterEach(() => {
  t.cleanup();
});

const count = (sql: string, ...args: unknown[]) => (t.sqlite.prepare(sql).get(...args) as { n: number }).n;

describe("housekeeping", () => {
  it("keeps the newest 2000 events", () => {
    const insert = t.sqlite.prepare("INSERT INTO events (at, level, scope, message) VALUES (?, 'info', 'test', 'x')");
    for (let i = 0; i < 2005; i += 1) insert.run(NOW - 10_000 + i);
    housekeeping(NOW);
    expect(count("SELECT COUNT(*) AS n FROM events")).toBe(2000);
    expect(count("SELECT MIN(at) AS n FROM events")).toBe(NOW - 10_000 + 5);
  });

  it("keeps the newest 50 source checks of each source", () => {
    const a = makeSource();
    const b = makeSource();
    const insert = t.sqlite.prepare(
      "INSERT INTO source_checks (source_id, started_at, finished_at, ok, items_found, items_new) VALUES (?, ?, ?, 1, 0, 0)",
    );
    for (let i = 0; i < 60; i += 1) insert.run(a.id, NOW - i, NOW - i);
    for (let i = 0; i < 10; i += 1) insert.run(b.id, NOW - i, NOW - i);
    housekeeping(NOW);
    expect(count("SELECT COUNT(*) AS n FROM source_checks WHERE source_id = ?", a.id)).toBe(50);
    expect(count("SELECT MIN(started_at) AS n FROM source_checks WHERE source_id = ?", a.id)).toBe(NOW - 49);
    expect(count("SELECT COUNT(*) AS n FROM source_checks WHERE source_id = ?", b.id)).toBe(10);
  });

  it("deletes the stories with no item and their search rows", () => {
    const orphan = makeStory();
    const kept = makeStory();
    makeItem({ sourceId: makeSource().id, storyId: kept.id });
    housekeeping(NOW);
    expect(count("SELECT COUNT(*) AS n FROM stories WHERE id = ?", orphan.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM stories_fts WHERE rowid = ?", orphan.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM stories WHERE id = ?", kept.id)).toBe(1);
  });

  it("puts stale running analyses back in the queue", () => {
    const feed = makeFeed();
    const story = makeStory();
    makeItem({ sourceId: makeSource().id, storyId: story.id });
    const otherStory = makeStory();
    makeItem({ sourceId: makeSource().id, storyId: otherStory.id });
    const insert = t.sqlite.prepare(
      `INSERT INTO analyses (feed_id, story_id, status, stage, requested_by, requested_at, updated_at)
       VALUES (?, ?, 'running', 'Writing', 'Ana', ?, ?)`,
    );
    insert.run(feed.id, story.id, NOW - 20 * MINUTE_MS, NOW - 16 * MINUTE_MS);
    insert.run(feed.id, otherStory.id, NOW - 20 * MINUTE_MS, NOW - 5 * MINUTE_MS);
    housekeeping(NOW);
    const rows = t.sqlite.prepare("SELECT story_id, status, stage FROM analyses ORDER BY id").all();
    expect(rows).toEqual([
      { story_id: story.id, status: "queued", stage: null },
      { story_id: otherStory.id, status: "running", stage: "Writing" },
    ]);
  });

  it("puts stale running re-judge requests back in the queue only when the model is not paused", () => {
    const feed = makeFeed();
    const insert = t.sqlite.prepare(
      `INSERT INTO rejudge_requests (feed_id, since_at, status, requested_by, requested_at, updated_at)
       VALUES (?, 0, 'running', 'Ana', ?, ?) RETURNING id`,
    );
    const { id } = insert.get(feed.id, NOW - 30 * MINUTE_MS, NOW - 20 * MINUTE_MS) as { id: number };
    setLlmPause({ until: NOW + MINUTE_MS, step: 1, lastError: "busy" }, NOW);
    housekeeping(NOW);
    expect(t.sqlite.prepare("SELECT status FROM rejudge_requests WHERE id = ?").get(id)).toEqual({ status: "running" });
    housekeeping(NOW + 2 * MINUTE_MS);
    expect(t.sqlite.prepare("SELECT status FROM rejudge_requests WHERE id = ?").get(id)).toEqual({ status: "queued" });
  });
});
