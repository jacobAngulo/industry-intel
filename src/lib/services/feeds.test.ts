import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activity, alerts, feedSources, feedTopics, feeds, items, judgements, rejudgeRequests, settings } from "@/lib/db/schema";
import { DAY_MS, HOUR_MS } from "@/lib/time";
import { DEFAULT_RELEVANCE_PRIORITIES, defaultFeedDefaults } from "@/lib/types";
import {
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

import { ServiceError } from "./_manage-errors";
import {
  archiveFeed,
  createFeed,
  deleteFeed,
  getFeedBySlug,
  listFeedSources,
  listFeeds,
  restoreFeed,
  setFeedSource,
  updateFeedDelivery,
  updateFeedInterests,
  updateFeedProfile,
} from "./feeds";

const NOW = 1_800_000_000_000;
const actor = { name: "Dana", clientId: "c1" };

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

async function expectCode(promise: Promise<unknown>, code: ServiceError["code"]): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

function activityRows() {
  return t.db.select().from(activity).all();
}

function judgementOf(id: number) {
  return t.db.select().from(judgements).all().find((row) => row.id === id)!;
}

/** A visible story in the feed with one item of the source. */
function storyIn(feedId: number, sourceId: number, overrides: { relevance?: number; createdAt?: number; depth?: "basic" | "intermediate" | "advanced" } = {}) {
  const at = overrides.createdAt ?? NOW;
  const story = makeStory({ freshAt: at, createdAt: at });
  makeItem({ sourceId, storyId: story.id, fetchedAt: at });
  const judgement = makeJudgement({
    feedId,
    storyId: story.id,
    relevance: overrides.relevance ?? 75,
    createdAt: at,
    judgedAt: at,
    ...(overrides.depth ? { depth: overrides.depth } : {}),
  });
  return { story, judgement };
}

const interests = (overrides: Partial<Parameters<typeof updateFeedInterests>[1]> = {}) => ({
  topicPriorities: {},
  exclusions: [],
  relevancePriorities: { ...DEFAULT_RELEVANCE_PRIORITIES },
  minRelevance: 60,
  halfLifeHours: 48,
  ...overrides,
});

const delivery = (overrides: Partial<Parameters<typeof updateFeedDelivery>[1]> = {}) => {
  const defaults = defaultFeedDefaults("UTC");
  return {
    briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: null },
    digest: defaults.digest,
    quietHours: defaults.quietHours,
    alerts: defaults.alerts,
    ...overrides,
  };
};

describe("listFeeds", () => {
  it("returns the active feeds in position order with their source count", async () => {
    const b = makeFeed({ name: "B", position: 2 });
    const a = makeFeed({ name: "A", position: 1 });
    makeFeed({ name: "Old", position: 0, archivedAt: NOW - DAY_MS });
    linkFeedSource(b.id, makeSource().id);
    linkFeedSource(b.id, makeSource().id);

    const list = await listFeeds();
    expect(list.map((feed) => [feed.id, feed.sourceCount, feed.archived])).toEqual([
      [a.id, 0, false],
      [b.id, 2, false],
    ]);
    expect((await listFeeds({ includeArchived: true })).map((feed) => feed.name)).toEqual(["Old", "A", "B"]);
  });

  it("lists only the alerts that the UI shows now (§9.3)", async () => {
    const on = { enabled: true, rule: "Anything big", minRelevance: 85 };
    const feed = makeFeed({ alerts: on });
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const alertFor = (visibleAt: number, hidden = false) => {
      const { story } = storyIn(feed.id, source.id);
      if (hidden) t.sqlite.prepare("UPDATE judgements SET hidden_reason = 'feedback' WHERE story_id = ?").run(story.id);
      return t.db.insert(alerts).values({ feedId: feed.id, storyId: story.id, createdAt: visibleAt, visibleAt }).returning().get().id;
    };
    const shown = alertFor(NOW - HOUR_MS);
    const edge = alertFor(NOW - 72 * HOUR_MS);
    alertFor(NOW - 73 * HOUR_MS); // too old
    alertFor(NOW + HOUR_MS); // quiet hours: later
    alertFor(NOW - HOUR_MS, true); // the judgement is hidden

    expect((await listFeeds())[0]?.alertIds).toEqual([shown, edge]);

    t.db.update(feeds).set({ alerts: { ...on, enabled: false } }).run();
    expect((await listFeeds())[0]?.alertIds).toEqual([]);
  });
});

describe("getFeedBySlug", () => {
  it("returns null for an unknown slug", async () => {
    expect(await getFeedBySlug("nope")).toBeNull();
  });

  it("gives the effective brief format from the shared default and the topic priorities", async () => {
    const feed = makeFeed({ briefFormat: { summaryLength: "short", technicalDepth: null, suggestedActions: null } });
    t.db.insert(settings).values({
      key: "brief_defaults",
      value: { summaryLength: "detailed", technicalDepth: "deep", suggestedActions: false },
      updatedAt: NOW,
    }).run();
    const topic = makeTopic();
    t.db.insert(feedTopics).values({ feedId: feed.id, topicId: topic.id, priority: "muted" }).run();

    const detail = await getFeedBySlug(feed.slug);
    expect(detail?.effectiveBriefFormat).toEqual({ summaryLength: "short", technicalDepth: "deep", suggestedActions: false });
    expect(detail?.topicPriorities).toEqual({ [topic.id]: "muted" });
  });
});

describe("createFeed", () => {
  it("starts from feed_defaults and default_exclusions, with a unique slug at the end", async () => {
    makeFeed({ position: 7 });
    const custom = { ...defaultFeedDefaults("Europe/Berlin"), minRelevance: 70, halfLifeHours: 24 };
    t.db.insert(settings).values([
      { key: "feed_defaults", value: custom, updatedAt: NOW },
      { key: "default_exclusions", value: ["Politics", "Crypto"], updatedAt: NOW },
    ]).run();

    const first = await createFeed({ name: "Agent Tools", purpose: "Tools for agents." }, actor);
    const second = await createFeed({ name: "Agent tools!", purpose: "" }, actor);

    expect(first).toMatchObject({
      slug: "agent-tools",
      name: "Agent Tools",
      purpose: "Tools for agents.",
      position: 8,
      minRelevance: 70,
      halfLifeHours: 24,
      exclusions: ["Politics", "Crypto"],
      digest: { timeZone: "Europe/Berlin" },
      briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: null },
      archived: false,
    });
    expect(second).toMatchObject({ slug: "agent-tools-2", position: 9 });
    expect(activityRows().map((row) => [row.action, row.entityId, row.actor])).toEqual([
      ["feed.create", first.id, "Dana"],
      ["feed.create", second.id, "Dana"],
    ]);
  });

  it("validates the input and needs a display name", async () => {
    const error = await expectCode(createFeed({ name: "  ", purpose: "" }, actor), "validation");
    expect(error.fieldErrors).toHaveProperty("name");
    await expectCode(createFeed({ name: "A", purpose: "x".repeat(301) }, actor), "validation");
    await expectCode(createFeed({ name: "A", purpose: "" }, { name: "Someone", clientId: "c" }), "needs_name");
    await expectCode(createFeed({ name: "A", purpose: "" }, { name: " ", clientId: "c" }), "needs_name");
    expect(t.db.select().from(feeds).all()).toEqual([]);
  });

  it("stops at 30 feeds (§14)", async () => {
    for (let i = 0; i < 30; i += 1) makeFeed();
    await expectCode(createFeed({ name: "One more", purpose: "" }, actor), "limit");
  });
});

describe("updateFeedProfile", () => {
  it("changes name, purpose, and project context; the slug stays", async () => {
    const feed = makeFeed({ name: "Old" });
    await updateFeedProfile(feed.id, { name: "New name", purpose: "P", projectContext: "Line 1\nLine 2" }, actor);
    const row = t.db.select().from(feeds).get()!;
    expect(row).toMatchObject({ name: "New name", purpose: "P", projectContext: "Line 1\nLine 2", slug: feed.slug });
    expect(activityRows()[0]).toMatchObject({ action: "feed.profile", entityType: "feed", entityId: feed.id });
  });

  it("throws not_found for an unknown feed and validation for long text", async () => {
    await expectCode(updateFeedProfile(999, { name: "A", purpose: "", projectContext: "" }, actor), "not_found");
    const feed = makeFeed();
    await expectCode(updateFeedProfile(feed.id, { name: "A", purpose: "", projectContext: "x".repeat(4001) }, actor), "validation");
  });
});

describe("updateFeedInterests", () => {
  it("writes feed_topics rows and deletes the row of a topic set to normal", async () => {
    const feed = makeFeed();
    const [a, b, c] = [makeTopic(), makeTopic(), makeTopic()];
    t.db.insert(feedTopics).values({ feedId: feed.id, topicId: b.id, priority: "high" }).run();
    t.db.insert(feedTopics).values({ feedId: feed.id, topicId: c.id, priority: "low" }).run();

    await updateFeedInterests(
      feed.id,
      interests({ topicPriorities: { [a.id]: "muted", [b.id]: "normal" }, exclusions: ["Crypto", " crypto ", "Hype"] }),
      actor,
    );
    const rows = t.db.select().from(feedTopics).all().map((row) => [row.topicId, row.priority]);
    expect(rows.sort()).toEqual([
      [a.id, "muted"],
      [c.id, "low"],
    ].sort());
    expect(t.db.select().from(feeds).get()?.exclusions).toEqual(["Crypto", "Hype"]);
    expect(activityRows().map((row) => row.action)).toEqual(["feed.interests"]);
  });

  it("rejects an unknown topic and bad numbers", async () => {
    const feed = makeFeed();
    const error = await expectCode(updateFeedInterests(feed.id, interests({ topicPriorities: { 999: "high" } }), actor), "validation");
    expect(error.fieldErrors).toHaveProperty("topicPriorities.999");
    await expectCode(updateFeedInterests(feed.id, interests({ minRelevance: 101 }), actor), "validation");
    await expectCode(updateFeedInterests(feed.id, interests({ halfLifeHours: 0 }), actor), "validation");
    await expectCode(updateFeedInterests(feed.id, interests({ exclusions: Array.from({ length: 51 }, (_, i) => `p${i}`) }), actor), "validation");
  });

  it("recomputes the rank of the last 30 days at once (rank-time, §8.4)", async () => {
    const feed = makeFeed({ minRelevance: 60 });
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const recent = storyIn(feed.id, source.id, { relevance: 65 });
    const old = storyIn(feed.id, source.id, { relevance: 65, createdAt: NOW - 31 * DAY_MS });

    await updateFeedInterests(feed.id, interests({ minRelevance: 70 }), actor);
    expect(judgementOf(recent.judgement.id).hiddenReason).toBe("below_threshold");
    expect(judgementOf(old.judgement.id).hiddenReason).toBeNull();

    const topic = makeTopic();
    t.db.update(judgements).set({ topicIds: [topic.id] }).run();
    await updateFeedInterests(feed.id, interests({ minRelevance: 0, topicPriorities: { [topic.id]: "muted" } }), actor);
    expect(judgementOf(recent.judgement.id).hiddenReason).toBe("muted_topic");
  });
});

describe("updateFeedInterests: partial saves (one section)", () => {
  it("changes only the keys of the input, so a save of one section keeps what another save wrote", async () => {
    const feed = makeFeed({ name: "Radar", minRelevance: 60, halfLifeHours: 48 });
    const [a, b] = [makeTopic(), makeTopic()];

    // Bob: an exclusion and a topic priority.
    await updateFeedInterests(feed.id, { exclusions: ["Crypto"] }, actor);
    await updateFeedInterests(feed.id, { topicPriorities: { [b.id]: "muted" } }, actor);
    // Alice, with an old page: only the minimum relevance, then only topic a.
    await updateFeedInterests(feed.id, { minRelevance: 70 }, actor);
    await updateFeedInterests(feed.id, { topicPriorities: { [a.id]: "high" } }, actor);

    const row = t.db.select().from(feeds).get();
    expect(row).toMatchObject({ exclusions: ["Crypto"], minRelevance: 70, halfLifeHours: 48 });
    expect(row?.relevancePriorities).toEqual(feed.relevancePriorities);
    const topicRows = t.db.select().from(feedTopics).all().map((r) => [r.topicId, r.priority]);
    expect(topicRows.sort()).toEqual([[a.id, "high"], [b.id, "muted"]].sort());
    expect(activityRows().map((r) => r.summary)).toEqual([
      'Changed the exclusions of the feed "Radar".',
      'Changed the topic priorities of the feed "Radar".',
      'Changed the minimum relevance of the feed "Radar".',
      'Changed the topic priorities of the feed "Radar".',
    ]);
  });

  it("validates only the keys that are present, and writes nothing for a save with no change", async () => {
    const feed = makeFeed({ minRelevance: 60 });
    await expectCode(updateFeedInterests(feed.id, { minRelevance: 101 }, actor), "validation");
    await expectCode(updateFeedInterests(feed.id, { halfLifeHours: 0 }, actor), "validation");
    await updateFeedInterests(feed.id, { minRelevance: 60 }, actor);
    expect(activityRows()).toEqual([]);
  });

  it("recomputes the rank only when a rank-time value changed (not for the half-life or the exclusions)", async () => {
    const feed = makeFeed({ minRelevance: 60 });
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const { judgement } = storyIn(feed.id, source.id, { relevance: 65 });
    t.db.update(judgements).set({ baseScore: 999 }).run();

    await updateFeedInterests(feed.id, { halfLifeHours: 12, exclusions: ["Hype"] }, actor);
    expect(judgementOf(judgement.id).baseScore).toBe(999);
    await updateFeedInterests(feed.id, { minRelevance: 70 }, actor);
    expect(judgementOf(judgement.id).hiddenReason).toBe("below_threshold");
    expect(judgementOf(judgement.id).baseScore).not.toBe(999);
  });
});

describe("updateFeedDelivery: partial saves (one section)", () => {
  it("changes only the keys of the input and names only them in the activity log", async () => {
    const feed = makeFeed({ name: "Radar" });
    const defaults = defaultFeedDefaults("UTC");
    const digest = { ...defaults.digest, frequency: "weekly" as const, weekday: 3 };
    const alertsOn = { ...defaults.alerts, enabled: !defaults.alerts.enabled };

    await updateFeedDelivery(feed.id, { digest }, actor);
    await updateFeedDelivery(feed.id, { alerts: alertsOn }, actor);
    await updateFeedDelivery(feed.id, { quietHours: { ...defaults.quietHours, enabled: !defaults.quietHours.enabled } }, actor);

    const row = t.db.select().from(feeds).get();
    expect(row?.digest).toMatchObject({ frequency: "weekly", weekday: 3 });
    expect(row?.alerts).toEqual(alertsOn);
    expect(row?.briefFormat).toEqual(feed.briefFormat);
    expect(activityRows().map((r) => r.summary)).toEqual([
      'Changed the digest of the feed "Radar".',
      'Changed the alerts of the feed "Radar".',
      'Changed the quiet hours of the feed "Radar".',
    ]);
  });

  it("recomputes the rank when a brief-format-only save changes the effective depth", async () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const { judgement } = storyIn(feed.id, source.id, { depth: "basic" });
    t.db.update(judgements).set({ baseScore: 999 }).run();

    await updateFeedDelivery(feed.id, { quietHours: { ...defaultFeedDefaults("UTC").quietHours, enabled: true } }, actor);
    expect(judgementOf(judgement.id).baseScore).toBe(999);
    await updateFeedDelivery(feed.id, { briefFormat: { summaryLength: null, technicalDepth: "deep", suggestedActions: null } }, actor);
    expect(judgementOf(judgement.id).rankParts.find((part) => part.key === "depth")?.value).toBe(-12);
  });
});

describe("updateFeedDelivery", () => {
  it("validates the time zone with Intl", async () => {
    const feed = makeFeed();
    const defaults = defaultFeedDefaults("UTC");
    const error = await expectCode(
      updateFeedDelivery(feed.id, delivery({ digest: { ...defaults.digest, timeZone: "Mars/Olympus" } }), actor),
      "validation",
    );
    expect(error.fieldErrors).toHaveProperty("digest.timeZone");
    await updateFeedDelivery(feed.id, delivery({ digest: { ...defaults.digest, timeZone: "America/New_York", frequency: "weekly", weekday: 3 } }), actor);
    expect(t.db.select().from(feeds).get()?.digest).toMatchObject({ timeZone: "America/New_York", frequency: "weekly", weekday: 3 });
    expect(activityRows().map((row) => row.action)).toEqual(["feed.delivery"]);
  });

  it("recomputes the rank when the effective technical depth changes, and only then", async () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const { judgement } = storyIn(feed.id, source.id, { depth: "basic" });

    t.db.update(judgements).set({ baseScore: 999 }).run();
    await updateFeedDelivery(feed.id, delivery({ briefFormat: { summaryLength: "short", technicalDepth: null, suggestedActions: false } }), actor);
    expect(judgementOf(judgement.id).baseScore).toBe(999);

    await updateFeedDelivery(feed.id, delivery({ briefFormat: { summaryLength: null, technicalDepth: "practitioner", suggestedActions: null } }), actor);
    expect(judgementOf(judgement.id).baseScore).toBe(999);

    await updateFeedDelivery(feed.id, delivery({ briefFormat: { summaryLength: null, technicalDepth: "deep", suggestedActions: null } }), actor);
    const deep = judgementOf(judgement.id);
    expect(deep.rankParts.find((part) => part.key === "depth")?.value).toBe(-12);

    await updateFeedDelivery(feed.id, delivery({ briefFormat: { summaryLength: null, technicalDepth: "overview", suggestedActions: null } }), actor);
    expect(judgementOf(judgement.id).baseScore).toBeCloseTo(deep.baseScore + 12, 1);
  });
});

describe("archiveFeed, restoreFeed, deleteFeed", () => {
  it("archives and restores a feed", async () => {
    const feed = makeFeed();
    await archiveFeed(feed.id, actor);
    expect(t.db.select().from(feeds).get()?.archivedAt).toBe(NOW);
    expect(await listFeeds()).toEqual([]);
    await restoreFeed(feed.id, actor);
    expect(t.db.select().from(feeds).get()?.archivedAt).toBeNull();
    expect(activityRows().map((row) => row.action)).toEqual(["feed.archive", "feed.restore"]);
  });

  it("deletes only an archived feed", async () => {
    const feed = makeFeed();
    await expectCode(deleteFeed(feed.id, actor), "conflict");
    await archiveFeed(feed.id, actor);
    await deleteFeed(feed.id, actor);
    expect(t.db.select().from(feeds).all()).toEqual([]);
    expect(activityRows().at(-1)).toMatchObject({ action: "feed.delete", entityId: feed.id });
    await expectCode(deleteFeed(feed.id, actor), "not_found");
  });
});

describe("listFeedSources", () => {
  it("lists every source of the directory with the link of this feed", async () => {
    const feed = makeFeed();
    const linked = makeSource({ name: "Linked" });
    const other = makeSource({ name: "Other" });
    linkFeedSource(feed.id, linked.id, { priority: "high", follow: "agents", ignore: "hiring" });

    const rows = await listFeedSources(feed.id);
    expect(rows.map((row) => [row.source.id, row.included, row.priority, row.follow, row.ignore])).toEqual([
      [linked.id, true, "high", "agents", "hiring"],
      [other.id, false, "normal", "", ""],
    ]);
    expect(rows[1]?.source.hints).toContain("Not in any feed: its items are not judged.");
  });
});

describe("setFeedSource", () => {
  it("include: inserts the link, backfills recent no_feed items, and queues a re-judge (§7.7)", async () => {
    const feed = makeFeed();
    const source = makeSource();
    const waiting = makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "no_feed", fetchedAt: NOW - DAY_MS });
    const tooOld = makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "no_feed", fetchedAt: NOW - 8 * DAY_MS });
    const story = makeStory();
    makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - HOUR_MS });

    const result = await setFeedSource(feed.id, source.id, { included: true, priority: "high", follow: "agents" }, actor);

    // 1 story to re-judge + 1 re-queued no_feed item (it becomes at most one story).
    expect(result).toEqual({ queuedStories: 2 });
    expect(t.db.select().from(feedSources).get()).toMatchObject({ priority: "high", follow: "agents", ignore: "", addedBy: "Dana" });
    const status = (id: number) => t.db.select().from(items).all().find((row) => row.id === id)?.judgeStatus;
    expect(status(waiting.id)).toBe("pending");
    expect(status(tooOld.id)).toBe("skipped");
    expect(t.db.select().from(rejudgeRequests).get()).toMatchObject({ feedId: feed.id, sourceId: source.id, maxStories: 8, total: 1 });
    expect(activityRows().map((row) => row.action)).toEqual(["feed.source.include"]);
  });

  it("include counts the re-queued no_feed items of a source that no feed used before", async () => {
    const feed = makeFeed();
    const source = makeSource();
    for (let i = 0; i < 8; i += 1) {
      makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "no_feed", fetchedAt: NOW - (i + 1) * HOUR_MS });
    }
    expect(await setFeedSource(feed.id, source.id, { included: true }, actor)).toEqual({ queuedStories: 8 });
  });

  it("include recomputes the rank: a story of the source is no longer source_removed", async () => {
    const feed = makeFeed();
    const source = makeSource();
    const { judgement } = storyIn(feed.id, source.id);
    t.db.update(judgements).set({ hiddenReason: "source_removed" }).run();

    await setFeedSource(feed.id, source.id, { included: true }, actor);
    expect(judgementOf(judgement.id).hiddenReason).toBeNull();
  });

  it("exclude: deletes the link and hides the stories of the source (source_removed)", async () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const { judgement } = storyIn(feed.id, source.id);

    expect(await setFeedSource(feed.id, source.id, { included: false }, actor)).toEqual({ queuedStories: 0 });
    expect(t.db.select().from(feedSources).all()).toEqual([]);
    expect(judgementOf(judgement.id).hiddenReason).toBe("source_removed");
    expect(activityRows().map((row) => row.action)).toEqual(["feed.source.exclude"]);
  });

  it("update: a new priority recomputes the rank; new Follow text queues no model work", async () => {
    const feed = makeFeed();
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    const { judgement } = storyIn(feed.id, source.id);
    t.db.update(judgements).set({ baseScore: 999 }).run();
    await setFeedSource(feed.id, source.id, { included: true, priority: "normal" }, actor);
    expect(judgementOf(judgement.id).baseScore).toBe(999); // same priority: no recompute

    const result = await setFeedSource(feed.id, source.id, { included: true, priority: "high", follow: "only agents" }, actor);
    expect(result).toEqual({ queuedStories: 0 });
    const after = judgementOf(judgement.id);
    expect(after.baseScore).not.toBe(999);
    expect(after.rankParts.find((part) => part.key === "source_priority")?.value).toBe(5);
    expect(t.db.select().from(feedSources).get()).toMatchObject({ priority: "high", follow: "only agents" });
    expect(t.db.select().from(rejudgeRequests).all()).toEqual([]);
  });

  it("validates the input and the ids", async () => {
    const feed = makeFeed();
    const source = makeSource();
    await expectCode(setFeedSource(999, source.id, { included: true }, actor), "not_found");
    await expectCode(setFeedSource(feed.id, 999, { included: true }, actor), "not_found");
    await expectCode(setFeedSource(feed.id, source.id, { included: true, follow: "x".repeat(301) }, actor), "validation");
    await expectCode(
      setFeedSource(feed.id, source.id, { included: true, priority: "urgent" as never }, actor),
      "validation",
    );
  });
});
