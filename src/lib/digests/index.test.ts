import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digests, feeds, settings } from "@/lib/db/schema";
import { DAY_MS, HOUR_MS } from "@/lib/time";
import type { DigestSettings } from "@/lib/types";
import {
  installTestDb,
  makeFeed,
  makeJudgement,
  makeStory,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { createDueDigests, digestTitle } from "./index";

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-20T12:00:00Z"); // Friday
const END = at("2026-11-20T08:30:00Z");
const PREVIOUS = at("2026-11-19T08:30:00Z");

let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});

afterEach(() => t.cleanup());

function dailyFeed(overrides: Partial<DigestSettings> = {}, name = "Agentic Development") {
  return makeFeed({
    name,
    digest: { frequency: "daily", weekday: 1, time: "08:30", timeZone: "UTC", maxStories: 10, ...overrides },
  });
}

/** A story with a visible judgement in the feed. */
function story(feedId: number, freshAt: number, options: { base?: number; createdAt?: number; hidden?: boolean; summary?: string[] } = {}) {
  const s = makeStory({
    freshAt,
    firstSeenAt: freshAt,
    lastItemAt: freshAt,
    createdAt: freshAt,
    primaryUrl: "https://example.com/news",
    ...(options.summary ? { summary: options.summary } : {}),
  });
  makeJudgement({
    feedId,
    storyId: s.id,
    baseScore: options.base ?? 70,
    createdAt: options.createdAt ?? freshAt,
    hiddenReason: options.hidden ? "below_threshold" : null,
    suggestedAction: "Try it in one project.",
  });
  return s;
}

function digestRows(feedId: number) {
  return t.db.select().from(digests).where(eq(digests.feedId, feedId)).orderBy(digests.periodEnd).all();
}

function addDigest(feedId: number, periodStart: number, periodEnd: number) {
  t.db.insert(digests).values({ feedId, periodStart, periodEnd, title: "Old", entries: [], createdAt: periodEnd }).run();
}

describe("createDueDigests", () => {
  it("first digest: the period is [occurrence before end, end)", () => {
    const feed = dailyFeed();
    const inside = story(feed.id, END - HOUR_MS);
    story(feed.id, PREVIOUS - HOUR_MS); // before the period
    story(feed.id, END + HOUR_MS); // after the end

    expect(createDueDigests(NOW)).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      periodStart: PREVIOUS,
      periodEnd: END,
      title: "Agentic Development — daily digest — 20 Nov 2026",
      createdAt: NOW,
    });
    expect(rows[0]!.entries.map((entry) => entry.storyId)).toEqual([inside.id]);
  });

  it("the period start is inclusive and the end is exclusive", () => {
    const feed = dailyFeed();
    const atStart = story(feed.id, PREVIOUS);
    story(feed.id, END);
    createDueDigests(NOW);
    expect(digestRows(feed.id)[0]!.entries.map((entry) => entry.storyId)).toEqual([atStart.id]);
  });

  it("uses max(fresh_at, judgements.created_at): an old story judged in the period is in", () => {
    const feed = dailyFeed();
    const late = story(feed.id, at("2026-11-10T00:00:00Z"), { createdAt: END - HOUR_MS });
    // Fresh in the period, but judged after the end: max is after the end.
    story(feed.id, END - HOUR_MS, { createdAt: END + HOUR_MS });
    createDueDigests(NOW);
    expect(digestRows(feed.id)[0]!.entries.map((entry) => entry.storyId)).toEqual([late.id]);
  });

  it("stores the snapshot with the DigestEntry fields, by base score, at most maxStories", () => {
    const feed = dailyFeed({ maxStories: 2 });
    const summary = ["One.", "Two.", "Three.", "Four.", "Five."];
    const a = story(feed.id, END - 3 * HOUR_MS, { base: 60, summary });
    const b = story(feed.id, END - 2 * HOUR_MS, { base: 90, summary });
    story(feed.id, END - HOUR_MS, { base: 50, summary });
    createDueDigests(NOW);
    const entries = digestRows(feed.id)[0]!.entries;
    expect(entries.map((entry) => entry.storyId)).toEqual([b.id, a.id]);
    expect(entries[0]).toEqual({
      storyId: b.id,
      headline: b.headline,
      summary: ["One.", "Two.", "Three.", "Four.", "Five."], // the full summary: the page cuts it at render time
      whyItMatters: "It changes a tool that the team uses.",
      suggestedAction: "Try it in one project.",
      relevance: 75,
      baseScore: 90,
      primaryUrl: "https://example.com/news",
      category: "release",
      freshAt: END - 2 * HOUR_MS,
    });
  });

  it("stores the full summary whatever the summary length of the feed (render-time, §8.4)", () => {
    const summary = ["One.", "Two.", "Three.", "Four.", "Five."];
    const shortFeed = makeFeed({
      digest: { frequency: "daily", weekday: 1, time: "08:30", timeZone: "UTC", maxStories: 10 },
      briefFormat: { summaryLength: "short", technicalDepth: null, suggestedActions: null },
    });
    story(shortFeed.id, END - HOUR_MS, { summary });
    const defaultFeed = dailyFeed();
    story(defaultFeed.id, END - HOUR_MS, { summary });
    t.db
      .insert(settings)
      .values({ key: "brief_defaults", value: { summaryLength: "detailed", technicalDepth: "practitioner", suggestedActions: true }, updatedAt: NOW })
      .run();

    createDueDigests(NOW);
    expect(digestRows(shortFeed.id)[0]!.entries[0]!.summary).toEqual(summary);
    expect(digestRows(defaultFeed.id)[0]!.entries[0]!.summary).toEqual(summary);
  });

  it("next digest: starts at the end of the last one", () => {
    const feed = dailyFeed();
    createDueDigests(NOW);
    const nextNow = NOW + DAY_MS;
    const s = story(feed.id, END + HOUR_MS);
    setNowForTests(nextNow);
    expect(createDueDigests(nextNow)).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ periodStart: END, periodEnd: END + DAY_MS });
    expect(rows[1]!.entries.map((entry) => entry.storyId)).toEqual([s.id]);
  });

  it("a restart does not make a second row", () => {
    const feed = dailyFeed();
    expect(createDueDigests(NOW)).toBe(1);
    expect(createDueDigests(NOW)).toBe(0);
    expect(createDueDigests(NOW + HOUR_MS)).toBe(0);
    expect(digestRows(feed.id)).toHaveLength(1);
  });

  it("downtime of 3 days: only the newest period, which starts at the old end", () => {
    const feed = dailyFeed();
    const oldEnd = END - 3 * DAY_MS;
    addDigest(feed.id, oldEnd - DAY_MS, oldEnd);
    const s1 = story(feed.id, oldEnd + HOUR_MS, { base: 50 });
    const s2 = story(feed.id, END - HOUR_MS, { base: 80 });

    expect(createDueDigests(NOW)).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ periodStart: oldEnd, periodEnd: END });
    expect(rows[1]!.entries.map((entry) => entry.storyId)).toEqual([s2.id, s1.id]);
  });

  it("downtime of 20 days: the start is the occurrence before the end", () => {
    const feed = dailyFeed();
    const oldEnd = END - 20 * DAY_MS;
    addDigest(feed.id, oldEnd - DAY_MS, oldEnd);
    story(feed.id, oldEnd + HOUR_MS);
    const recent = story(feed.id, END - HOUR_MS);

    expect(createDueDigests(NOW)).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows[1]).toMatchObject({ periodStart: PREVIOUS, periodEnd: END });
    expect(rows[1]!.entries.map((entry) => entry.storyId)).toEqual([recent.id]);
  });

  it("the newest digest exactly 8 days before the end still starts the period", () => {
    const feed = dailyFeed();
    addDigest(feed.id, END - 9 * DAY_MS, END - 8 * DAY_MS);
    createDueDigests(NOW);
    expect(digestRows(feed.id)[1]!.periodStart).toBe(END - 8 * DAY_MS);
  });

  it("a changed digest time does not make a duplicate digest", () => {
    const feed = dailyFeed({ time: "08:30" });
    expect(createDueDigests(NOW)).toBe(1);

    // The time moves earlier, to 08:00: the period that ends today at 08:00
    // is older than the digest of today (08:30), so nothing is due.
    t.db
      .update(feeds)
      .set({ digest: { frequency: "daily", weekday: 1, time: "08:00", timeZone: "UTC", maxStories: 10 } })
      .where(eq(feeds.id, feed.id))
      .run();
    expect(createDueDigests(NOW)).toBe(0);
    expect(digestRows(feed.id)).toHaveLength(1);

    // The next day: one digest from the old end to the new time.
    const nextNow = NOW + DAY_MS;
    expect(createDueDigests(nextNow)).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ periodStart: END, periodEnd: at("2026-11-21T08:00:00Z") });
  });

  it("stores a row with zero entries, so the period is not tested again", () => {
    const feed = dailyFeed();
    expect(createDueDigests(NOW)).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entries).toEqual([]);
    expect(createDueDigests(NOW)).toBe(0);
  });

  it("hidden judgements stay out", () => {
    const feed = dailyFeed();
    story(feed.id, END - HOUR_MS, { hidden: true });
    const visible = story(feed.id, END - 2 * HOUR_MS);
    createDueDigests(NOW);
    expect(digestRows(feed.id)[0]!.entries.map((entry) => entry.storyId)).toEqual([visible.id]);
  });

  it("judgements of another feed stay out", () => {
    const feed = dailyFeed();
    const other = dailyFeed({}, "Other");
    story(other.id, END - HOUR_MS);
    createDueDigests(NOW);
    expect(digestRows(feed.id)[0]!.entries).toEqual([]);
    expect(digestRows(other.id)[0]!.entries).toHaveLength(1);
  });

  it("skips an archived feed and a feed with frequency off", () => {
    const archived = makeFeed({
      digest: { frequency: "daily", weekday: 1, time: "08:30", timeZone: "UTC", maxStories: 10 },
      archivedAt: NOW - DAY_MS,
    });
    const off = dailyFeed({ frequency: "off" });
    expect(createDueDigests(NOW)).toBe(0);
    expect(digestRows(archived.id)).toHaveLength(0);
    expect(digestRows(off.id)).toHaveLength(0);
  });

  it("follows the weekday schedule: nothing new on a Saturday after Friday's digest", () => {
    const feed = dailyFeed({ frequency: "weekdays" });
    expect(createDueDigests(NOW)).toBe(1);
    expect(createDueDigests(at("2026-11-21T12:00:00Z"))).toBe(0);
    expect(createDueDigests(at("2026-11-23T09:00:00Z"))).toBe(1);
    const rows = digestRows(feed.id);
    expect(rows[1]).toMatchObject({ periodStart: END, periodEnd: at("2026-11-23T08:30:00Z") });
    expect(rows[1]!.title).toBe("Agentic Development — weekday digest — 23 Nov 2026");
  });

  it("returns 0 with no feed", () => {
    expect(createDueDigests(NOW)).toBe(0);
  });
});

describe("digestTitle", () => {
  it("uses the frequency word and the date of the end in the feed time zone", () => {
    const end = at("2026-11-19T21:30:00Z"); // 08:30 on 20 Nov in Sydney
    const settingsFor = (frequency: DigestSettings["frequency"]): DigestSettings => ({
      frequency,
      weekday: 5,
      time: "08:30",
      timeZone: "Australia/Sydney",
      maxStories: 10,
    });
    expect(digestTitle("Industry Radar", settingsFor("daily"), end)).toBe("Industry Radar — daily digest — 20 Nov 2026");
    expect(digestTitle("Industry Radar", settingsFor("weekdays"), end)).toBe("Industry Radar — weekday digest — 20 Nov 2026");
    expect(digestTitle("Industry Radar", settingsFor("weekly"), end)).toBe("Industry Radar — weekly digest — 20 Nov 2026");
  });
});
