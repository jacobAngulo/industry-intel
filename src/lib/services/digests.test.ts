import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSqlite } from "@/lib/db/client";
import { DAY_MS } from "@/lib/time";
import type { DigestEntry } from "@/lib/types";
import { installTestDb, makeFeed, makeStory, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { NOW } from "./_read-testkit";
import { getDigest, latestDigest, listDigests } from "./digests";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

function entry(storyId: number, headline = `Story ${storyId}`): DigestEntry {
  return {
    storyId,
    headline,
    summary: ["A fact."],
    whyItMatters: "It matters.",
    suggestedAction: null,
    relevance: 80,
    baseScore: 80,
    primaryUrl: "https://example.com/a",
    category: "release",
    freshAt: NOW - DAY_MS,
  };
}

function addDigest(feedId: number, periodEnd: number, entries: DigestEntry[], title = `Digest ${periodEnd}`): number {
  return Number(
    getSqlite()
      .prepare("INSERT INTO digests (feed_id, period_start, period_end, title, entries, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(feedId, periodEnd - DAY_MS, periodEnd, title, JSON.stringify(entries), periodEnd).lastInsertRowid,
  );
}

describe("listDigests", () => {
  it("lists only the digests with entries, newest period first, with the entry count", async () => {
    const feed = makeFeed();
    const story = makeStory();
    const first = addDigest(feed.id, NOW - 3 * DAY_MS, [entry(story.id)]);
    addDigest(feed.id, NOW - 2 * DAY_MS, []);
    const third = addDigest(feed.id, NOW - DAY_MS, [entry(story.id), entry(story.id + 1)], "Daily");
    addDigest(makeFeed().id, NOW, [entry(story.id)]);

    const rows = await listDigests(feed.id);
    expect(rows.map((row) => row.id)).toEqual([third, first]);
    expect(rows[0]).toEqual({
      id: third,
      title: "Daily",
      periodStart: NOW - 2 * DAY_MS,
      periodEnd: NOW - DAY_MS,
      entryCount: 2,
      createdAt: NOW - DAY_MS,
    });
  });

  it("returns [] for a feed with no digest", async () => {
    expect(await listDigests(makeFeed().id)).toEqual([]);
  });
});

describe("getDigest", () => {
  it("returns the snapshot entries and says which stories still exist", async () => {
    const feed = makeFeed();
    const kept = makeStory();
    const gone = makeStory();
    const id = addDigest(feed.id, NOW, [entry(kept.id, "Kept"), entry(gone.id, "Gone")]);
    getSqlite().prepare("DELETE FROM stories WHERE id = ?").run(gone.id);

    const view = await getDigest(feed.id, id);
    expect(view?.entryCount).toBe(2);
    expect(view?.entries.map((e) => [e.headline, e.storyExists])).toEqual([
      ["Kept", true],
      ["Gone", false],
    ]);
    expect(view?.entries[0]).toMatchObject({ summary: ["A fact."], whyItMatters: "It matters.", relevance: 80 });
  });

  it("returns null for a digest of another feed or an unknown id", async () => {
    const feed = makeFeed();
    const id = addDigest(makeFeed().id, NOW, [entry(1)]);
    expect(await getDigest(feed.id, id)).toBeNull();
    expect(await getDigest(feed.id, 999)).toBeNull();
  });
});

describe("latestDigest", () => {
  it("returns the newest digest that has entries", async () => {
    const feed = makeFeed();
    expect(await latestDigest(feed.id)).toBeNull();
    const withEntries = addDigest(feed.id, NOW - DAY_MS, [entry(1)]);
    addDigest(feed.id, NOW, []);
    expect((await latestDigest(feed.id))?.id).toBe(withEntries);
  });
});
