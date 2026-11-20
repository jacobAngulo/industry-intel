import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activity, items, judgements, sourceChecks, sourceFlags, sources, stories } from "@/lib/db/schema";
import { writeWorkerState } from "@/lib/pipeline/jobs";
import { DAY_MS, HOUR_MS } from "@/lib/time";
import {
  addVote,
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
import { LOW_SIGNAL_HINT, NOT_IN_FEED_HINT } from "./_manage-source-rows";
import {
  deleteSource,
  flagNoisy,
  getSource,
  listSources,
  requestCheck,
  requestCheckAllDue,
  resolveFlags,
  setPaused,
  updateSource,
} from "./sources";

const NOW = 1_800_000_000_000;
const actor = { name: "Dana", clientId: "c1" };

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
  heartbeat({ hasXToken: true, hasModelKey: true, hasMailbox: true });
});
afterEach(() => t.cleanup());

/** The worker's view of the keys decides the status (§13). */
function heartbeat(keys: { hasXToken: boolean; hasModelKey: boolean; hasMailbox: boolean }) {
  writeWorkerState("heartbeat", { at: NOW, ...keys }, NOW);
}

async function expectCode(promise: Promise<unknown>, code: ServiceError["code"]): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

const checked = { lastCheckedAt: NOW - HOUR_MS, lastSuccessAt: NOW - HOUR_MS };
const rowOf = async (id: number) => (await listSources()).find((row) => row.id === id)!;
const sourceRow = (id: number) => t.db.select().from(sources).all().find((row) => row.id === id);

describe("listSources: status (§10.2)", () => {
  it("derives each status, first match wins", async () => {
    const paused = makeSource({ paused: true, consecutiveFailures: 5 });
    const xUser = makeSource({ type: "x_user", ...checked });
    const inbox = makeSource({ type: "newsletter", config: { variant: "inbox", sender: "news@example.com" }, ...checked });
    const search = makeSource({ type: "web_search", ...checked });
    const failing = makeSource({ consecutiveFailures: 3, lastError: "The feed address returned 404.", ...checked });
    const twoFailures = makeSource({ consecutiveFailures: 2, ...checked });
    const waiting = makeSource();
    const active = makeSource({ ...checked });

    heartbeat({ hasXToken: false, hasModelKey: false, hasMailbox: false });
    const list = await listSources();
    const status = (id: number) => list.find((row) => row.id === id)?.status;
    expect(status(paused.id)).toBe("paused");
    expect(status(xUser.id)).toBe("needs_token");
    expect(status(inbox.id)).toBe("needs_setup");
    expect(status(search.id)).toBe("needs_setup");
    expect(status(failing.id)).toBe("failing");
    expect(status(twoFailures.id)).toBe("active");
    expect(status(waiting.id)).toBe("waiting");
    expect(status(active.id)).toBe("active");
    expect(list.find((row) => row.id === xUser.id)?.statusDetail).toContain("X_BEARER_TOKEN");
    expect(list.find((row) => row.id === inbox.id)?.statusDetail).toContain("IMAP_HOST");
    expect(list.find((row) => row.id === failing.id)?.statusDetail).toBe("The feed address returned 404.");

    heartbeat({ hasXToken: true, hasModelKey: true, hasMailbox: true });
    const ready = await listSources();
    expect(ready.find((row) => row.id === xUser.id)?.status).toBe("active");
    expect(ready.find((row) => row.id === inbox.id)?.status).toBe("active");
    expect(ready.find((row) => row.id === search.id)?.status).toBe("active");
  });
});

describe("listSources: hints (§10.3) and statistics", () => {
  it("says when the source is in no feed, and lists the active feeds", async () => {
    const source = makeSource();
    expect((await rowOf(source.id)).hints).toEqual([NOT_IN_FEED_HINT]);

    const b = makeFeed({ name: "B", position: 2 });
    const a = makeFeed({ name: "A", position: 1 });
    const archived = makeFeed({ archivedAt: NOW });
    for (const feed of [a, b, archived]) linkFeedSource(feed.id, source.id);
    const row = await rowOf(source.id);
    expect(row.feeds.map((feed) => feed.id)).toEqual([a.id, b.id]);
    expect(row.hints).toEqual([]);
  });

  it("counts the people who flagged the source as noisy", async () => {
    const source = makeSource();
    const flag = (by: string, resolved = false) =>
      t.db.insert(sourceFlags).values({ sourceId: source.id, note: "", createdBy: by, createdAt: NOW, resolvedAt: resolved ? NOW : null }).run();
    flag("Ann");
    expect((await rowOf(source.id)).hints).toContain("Flagged as noisy by 1 person.");
    flag("ann");
    flag("Ben");
    flag("Cy", true);
    const row = await rowOf(source.id);
    expect(row.openFlags).toBe(3);
    expect(row.hints).toContain("Flagged as noisy by 2 people.");
  });

  it("says since when a failing source fails, with the error and the next try", async () => {
    const source = makeSource({
      consecutiveFailures: 3,
      lastError: "Timeout",
      lastCheckedAt: NOW,
      lastSuccessAt: Date.UTC(2027, 0, 1),
      nextCheckAt: Date.UTC(2027, 0, 15, 12, 0),
    });
    for (const day of [2, 3, 4]) {
      t.db.insert(sourceChecks).values({ sourceId: source.id, startedAt: Date.UTC(2027, 0, day, 9, 30), finishedAt: Date.UTC(2027, 0, day, 9, 31), ok: false, error: "Timeout" }).run();
    }
    expect((await rowOf(source.id)).hints).toContain("Failing since 2 Jan 2027, 09:30 UTC: Timeout. Next try: 15 Jan 2027, 12:00 UTC.");
  });

  it("shows a failed last check at once, before the source is failing, with the error as the detail", async () => {
    const feed = makeFeed();
    const source = makeSource({
      consecutiveFailures: 0,
      lastError: "The X API account has no credits left.",
      lastCheckedAt: NOW,
      nextCheckAt: Date.UTC(2027, 0, 15, 0, 0),
    });
    linkFeedSource(feed.id, source.id);
    let row = await rowOf(source.id);
    expect(row.status).toBe("active");
    expect(row.statusDetail).toBe("The X API account has no credits left.");
    expect(row.hints).toEqual(["The last check failed: The X API account has no credits left. Next try: 15 Jan 2027, 00:00 UTC."]);

    t.db.update(sources).set({ paused: true }).where(eq(sources.id, source.id)).run();
    row = await rowOf(source.id);
    expect(row.statusDetail).toBeNull();
    expect(row.hints).toEqual([]);

    t.db.update(sources).set({ paused: false, lastError: null }).where(eq(sources.id, source.id)).run();
    row = await rowOf(source.id);
    expect(row.statusDetail).toBeNull();
    expect(row.hints).toEqual([]);
  });

  it("gives the low-signal hint for >= 20 judged items in 30 days with < 5 % shown", async () => {
    const feed = makeFeed();
    const source = makeSource({ ...checked });
    linkFeedSource(feed.id, source.id);
    const hidden = makeStory();
    makeJudgement({ feedId: feed.id, storyId: hidden.id, hiddenReason: "below_threshold" });
    for (let i = 0; i < 20; i += 1) makeItem({ sourceId: source.id, storyId: hidden.id, fetchedAt: NOW - DAY_MS });
    makeItem({ sourceId: source.id, storyId: hidden.id, fetchedAt: NOW - 31 * DAY_MS }); // outside the window

    let row = await rowOf(source.id);
    expect(row.signalRate).toBe(0);
    expect(row.hints).toContain(LOW_SIGNAL_HINT);

    const shown = makeStory();
    makeJudgement({ feedId: feed.id, storyId: shown.id });
    makeItem({ sourceId: source.id, storyId: shown.id, fetchedAt: NOW - DAY_MS });
    row = await rowOf(source.id);
    expect(row.signalRate).toBeCloseTo(1 / 21, 5); // 4.8 %: still low
    expect(row.hints).toContain(LOW_SIGNAL_HINT);

    makeItem({ sourceId: source.id, storyId: shown.id, fetchedAt: NOW - DAY_MS });
    row = await rowOf(source.id);
    expect(row.signalRate).toBeCloseTo(2 / 22, 5);
    expect(row.hints).not.toContain(LOW_SIGNAL_HINT);
  });

  it("does not give the low-signal hint below 20 judged items", async () => {
    const source = makeSource({ ...checked });
    const story = makeStory();
    for (let i = 0; i < 19; i += 1) makeItem({ sourceId: source.id, storyId: story.id });
    expect((await rowOf(source.id)).hints).not.toContain(LOW_SIGNAL_HINT);
    expect((await rowOf(source.id)).signalRate).toBe(0);
    expect((await rowOf(makeSource().id)).signalRate).toBeNull();
  });

  it("counts useful stories: useful votes outnumber off_topic + too_basic (§8.5)", async () => {
    const feed = makeFeed();
    const source = makeSource();
    const good = makeStory();
    const mixed = makeStory();
    makeItem({ sourceId: source.id, storyId: good.id });
    makeItem({ sourceId: source.id, storyId: good.id });
    makeItem({ sourceId: source.id, storyId: mixed.id });
    addVote({ feedId: feed.id, storyId: good.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: good.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: good.id, reason: "off_topic" });
    addVote({ feedId: feed.id, storyId: mixed.id, reason: "useful" });
    addVote({ feedId: feed.id, storyId: mixed.id, reason: "too_basic" });
    expect((await rowOf(source.id)).usefulStories).toBe(1);
  });
});

describe("listSources: filters and sorts (§4.5)", () => {
  it("filters by type, status, feed, owner, and name", async () => {
    const feed = makeFeed();
    const a = makeSource({ name: "Alpha blog", owner: "Dana", ...checked });
    const b = makeSource({ name: "Beta repo", type: "github", owner: "dana ", paused: true });
    const c = makeSource({ name: "Gamma", owner: "Eve" });
    linkFeedSource(feed.id, c.id);

    const ids = async (filter: Parameters<typeof listSources>[0]) => (await listSources(filter)).map((row) => row.id);
    expect(await ids({ type: "github" })).toEqual([b.id]);
    expect(await ids({ status: "paused" })).toEqual([b.id]);
    expect(await ids({ feedId: feed.id })).toEqual([c.id]);
    expect(await ids({ owner: "DANA" })).toEqual([a.id, b.id]);
    expect(await ids({ q: "REPO" })).toEqual([b.id]);
  });

  it("sorts by name, last check, or useful stories; Owner: me puts flagged sources first", async () => {
    const feed = makeFeed();
    const z = makeSource({ name: "Zulu", owner: "Dana", lastSuccessAt: NOW - HOUR_MS, lastCheckedAt: NOW });
    const y = makeSource({ name: "yankee", owner: "Dana", lastSuccessAt: NOW - DAY_MS, lastCheckedAt: NOW });
    makeSource({ name: "X-ray", owner: "Dana" });
    const story = makeStory();
    makeItem({ sourceId: y.id, storyId: story.id });
    addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    t.db.insert(sourceFlags).values({ sourceId: z.id, note: "", createdBy: "Ann", createdAt: NOW }).run();

    const order = async (filter: Parameters<typeof listSources>[0]) => (await listSources(filter)).map((row) => row.name);
    expect(await order({ sort: "name" })).toEqual(["X-ray", "yankee", "Zulu"]);
    expect(await order({ sort: "last_check" })).toEqual(["Zulu", "yankee", "X-ray"]);
    expect(await order({ sort: "useful" })).toEqual(["yankee", "X-ray", "Zulu"]);
    expect(await order({ owner: "Dana", sort: "name" })).toEqual(["Zulu", "X-ray", "yankee"]);
  });
});

describe("getSource", () => {
  it("returns null for an unknown id", async () => {
    expect(await getSource(999)).toBeNull();
  });

  it("returns the detail: feed links, newest 20 checks, stats, flags, and recent items with outcomes", async () => {
    const a = makeFeed({ name: "A", position: 1 });
    const b = makeFeed({ name: "B", position: 2 });
    makeFeed({ name: "Archived", archivedAt: NOW });
    const source = makeSource({ why: "Because.", checkRequestedAt: NOW, ...checked });
    linkFeedSource(a.id, source.id, { priority: "high", follow: "agents", ignore: "hiring" });

    for (let i = 0; i < 25; i += 1) {
      t.db.insert(sourceChecks).values({ sourceId: source.id, startedAt: NOW - i * HOUR_MS, finishedAt: NOW - i * HOUR_MS + 1000, ok: i !== 1, itemsFound: 3, itemsNew: 1, error: i === 1 ? "Boom" : null }).run();
    }
    t.db.insert(sourceFlags).values([
      { sourceId: source.id, note: "old", createdBy: "Ann", createdAt: NOW - DAY_MS, resolvedAt: NOW, resolvedBy: "Dana" },
      { sourceId: source.id, note: "too many", createdBy: "Ben", createdAt: NOW - HOUR_MS },
    ]).run();

    const story = makeStory();
    const judged = makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - 2 * HOUR_MS });
    makeJudgement({ feedId: a.id, storyId: story.id, relevance: 55, hiddenReason: "below_threshold" });
    const pending = makeItem({ sourceId: source.id, fetchedAt: NOW - HOUR_MS });
    const skipped = makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "too_old", fetchedAt: NOW });
    addVote({ feedId: a.id, storyId: story.id, reason: "off_topic" });
    addVote({ feedId: a.id, storyId: story.id, reason: "useful", createdAt: NOW - 40 * DAY_MS });

    const detail = (await getSource(source.id))!;
    expect(detail).toMatchObject({ why: "Because.", checkRequested: true, checkIntervalMinutes: 60, status: "active" });
    expect(detail.feedLinks).toEqual([
      { feedId: a.id, slug: a.slug, name: "A", included: true, priority: "high", follow: "agents", ignore: "hiring" },
      { feedId: b.id, slug: b.slug, name: "B", included: false, priority: "normal", follow: "", ignore: "" },
    ]);
    expect(detail.checks).toHaveLength(20);
    expect(detail.checks[0]).toMatchObject({ startedAt: NOW, ok: true });
    expect(detail.checks[1]).toMatchObject({ ok: false, error: "Boom" });
    expect(detail.stats).toEqual({
      itemsFetched: 3,
      itemsJudged: 1,
      storiesShown: 0,
      votes: { useful: 0, too_basic: 0, off_topic: 1, already_knew: 0 },
      signalRate: 0,
      usefulStories: 0,
    });
    expect(detail.flags.map((flag) => [flag.note, flag.resolvedBy])).toEqual([
      ["too many", null],
      ["old", "Dana"],
    ]);
    expect(detail.recentItems.map((item) => [item.itemId, item.judgeStatus, item.skipReason])).toEqual([
      [skipped.id, "skipped", "too_old"],
      [pending.id, "pending", null],
      [judged.id, "judged", null],
    ]);
    expect(detail.recentItems[2]?.perFeed).toEqual([{ feedSlug: a.slug, feedName: "A", relevance: 55, hidden: "below_threshold" }]);
    expect(detail.recentItems[1]?.perFeed).toEqual([{ feedSlug: a.slug, feedName: "A", relevance: null, hidden: null }]);
  });
});

describe("updateSource", () => {
  it("changes the common fields and a config field that is not part of the identity", async () => {
    const source = makeSource({ type: "blog", config: { feedUrl: "https://example.com/feed.xml" } });
    await updateSource(source.id, { name: "New", why: "Useful.", owner: "", checkIntervalMinutes: 30, config: { feedUrl: "https://example.com/feed.xml", fullText: true } }, actor);
    const row = sourceRow(source.id)!;
    expect(row).toMatchObject({ name: "New", why: "Useful.", owner: null, checkIntervalMinutes: 30, key: source.key });
    expect(row.config).toMatchObject({ fullText: true, sections: [] });
    expect(t.db.select().from(activity).get()).toMatchObject({ action: "source.update", entityId: source.id });
  });

  it("moves the next check to now when the interval or the config changes, and a new config clears the failures", async () => {
    const later = NOW + 6 * DAY_MS;
    const source = makeSource({ type: "blog", config: { feedUrl: "https://example.com/feed.xml" }, nextCheckAt: later, consecutiveFailures: 3 });

    await updateSource(source.id, { name: "Renamed", checkIntervalMinutes: source.checkIntervalMinutes }, actor);
    expect(sourceRow(source.id)).toMatchObject({ nextCheckAt: later, consecutiveFailures: 3 });

    await updateSource(source.id, { checkIntervalMinutes: source.checkIntervalMinutes + 30 }, actor);
    expect(sourceRow(source.id)).toMatchObject({ nextCheckAt: NOW, consecutiveFailures: 3 });

    t.db.update(sources).set({ nextCheckAt: later }).where(eq(sources.id, source.id)).run();
    await updateSource(source.id, { config: { feedUrl: "https://example.com/feed.xml", fullText: true } }, actor);
    expect(sourceRow(source.id)).toMatchObject({ nextCheckAt: NOW, consecutiveFailures: 0 });
  });

  it("rejects a change of an identity field (the key stays)", async () => {
    const source = makeSource({ type: "github", config: { owner: "a", repo: "b" } });
    const error = await expectCode(updateSource(source.id, { config: { owner: "a", repo: "c" } }, actor), "validation");
    expect(error.fieldErrors).toEqual({ "config.repo": "This field cannot change." });
    expect(sourceRow(source.id)?.config).toMatchObject({ repo: "b" });
  });

  it("validates the config with the schema of the type, and the other fields", async () => {
    const source = makeSource({ type: "github", config: { owner: "a", repo: "b" } });
    const error = await expectCode(updateSource(source.id, { config: { owner: "a", repo: "b", releases: "yes" } }, actor), "validation");
    expect(Object.keys(error.fieldErrors ?? {})).toEqual(["config.releases"]);
    await expectCode(updateSource(source.id, { checkIntervalMinutes: 1 }, actor), "validation");
    await expectCode(updateSource(source.id, { name: "" }, actor), "validation");
    await expectCode(updateSource(999, { name: "A" }, actor), "not_found");
    expect(t.db.select().from(activity).all()).toEqual([]);
  });
});

describe("deleteSource (§5)", () => {
  it("deletes the source; shared stories keep their other items; lone stories go", async () => {
    const feed = makeFeed();
    const gone = makeSource();
    const stays = makeSource();
    linkFeedSource(feed.id, gone.id);
    linkFeedSource(feed.id, stays.id, { priority: "high" });

    const shared = makeStory({ itemCount: 2, sourceCount: 2 });
    const first = makeItem({ sourceId: gone.id, storyId: shared.id, publishedAt: NOW - 2 * HOUR_MS });
    const second = makeItem({ sourceId: stays.id, storyId: shared.id, publishedAt: NOW - HOUR_MS, url: "https://example.com/second" });
    t.db.update(stories).set({ primaryItemId: first.id, primaryUrl: first.url }).run();
    const sharedJudgement = makeJudgement({ feedId: feed.id, storyId: shared.id });
    const lone = makeStory();
    makeItem({ sourceId: gone.id, storyId: lone.id });
    makeJudgement({ feedId: feed.id, storyId: lone.id });
    t.db.insert(sourceFlags).values({ sourceId: gone.id, note: "", createdBy: "Ann", createdAt: NOW }).run();

    await deleteSource(gone.id, actor);

    expect(sourceRow(gone.id)).toBeUndefined();
    expect(t.db.select().from(items).all().map((item) => item.id)).toEqual([second.id]);
    const remaining = t.db.select().from(stories).all();
    expect(remaining.map((story) => story.id)).toEqual([shared.id]);
    expect(remaining[0]).toMatchObject({ itemCount: 1, sourceCount: 1, primaryItemId: second.id, primaryUrl: "https://example.com/second" });
    const fts = t.sqlite.prepare("SELECT rowid FROM stories_fts ORDER BY rowid").all() as Array<{ rowid: number }>;
    expect(fts.map((row) => row.rowid)).toEqual([shared.id]);
    const judgement = t.db.select().from(judgements).all();
    expect(judgement.map((row) => row.id)).toEqual([sharedJudgement.id]);
    expect(judgement[0]?.rankParts.find((part) => part.key === "source_priority")?.value).toBe(5);
    expect(t.db.select().from(sourceFlags).all()).toEqual([]);
    expect(t.db.select().from(activity).get()).toMatchObject({ action: "source.delete", entityId: gone.id });
  });

  it("throws not_found for an unknown source", async () => {
    await expectCode(deleteSource(999, actor), "not_found");
  });
});

describe("setPaused, requestCheck, requestCheckAllDue", () => {
  it("pauses and resumes", async () => {
    const source = makeSource();
    await setPaused(source.id, true, actor);
    expect(sourceRow(source.id)?.paused).toBe(true);
    await setPaused(source.id, false, actor);
    expect(sourceRow(source.id)?.paused).toBe(false);
    expect(t.db.select().from(activity).all().map((row) => row.action)).toEqual(["source.pause", "source.resume"]);
  });

  it("requestCheck sets check_requested_at = now", async () => {
    const source = makeSource();
    await requestCheck(source.id, actor);
    expect(sourceRow(source.id)?.checkRequestedAt).toBe(NOW);
  });

  it("requestCheckAllDue asks for a check of each source that is not paused", async () => {
    const a = makeSource();
    const b = makeSource();
    const paused = makeSource({ paused: true });
    expect(await requestCheckAllDue(actor)).toBe(2);
    expect([a, b, paused].map((s) => sourceRow(s.id)?.checkRequestedAt)).toEqual([NOW, NOW, null]);
    expect(t.db.select().from(activity).get()).toMatchObject({ action: "source.check_all", entityId: null });
  });

  it("requestCheckAllDue skips a source whose connector needs a missing credential (as the worker sees it)", async () => {
    heartbeat({ hasXToken: false, hasModelKey: true, hasMailbox: false });
    const blog = makeSource();
    const x = makeSource({ type: "x_user" });
    const inbox = makeSource({ type: "newsletter", config: { variant: "inbox", sender: "news@example.com" } });
    expect(await requestCheckAllDue(actor)).toBe(1);
    expect([blog, x, inbox].map((s) => sourceRow(s.id)?.checkRequestedAt)).toEqual([NOW, null, null]);
  });
});

describe("flagNoisy and resolveFlags", () => {
  it("needs a name and writes a flag with the optional note", async () => {
    const source = makeSource();
    await expectCode(flagNoisy(source.id, "", { name: "", clientId: "c" }), "needs_name");
    await expectCode(flagNoisy(source.id, "", { name: "Someone", clientId: "c" }), "needs_name");
    await expectCode(flagNoisy(source.id, "x".repeat(301), actor), "validation");
    await flagNoisy(source.id, " Too many launch posts ", actor);
    await flagNoisy(source.id, "", { name: "Ben", clientId: "c2" });
    expect(t.db.select().from(sourceFlags).all().map((flag) => [flag.note, flag.createdBy])).toEqual([
      ["Too many launch posts", "Dana"],
      ["", "Ben"],
    ]);

    await resolveFlags(source.id, { name: "Eve", clientId: "c3" });
    expect(t.db.select().from(sourceFlags).all().every((flag) => flag.resolvedAt === NOW && flag.resolvedBy === "Eve")).toBe(true);
    expect((await rowOf(source.id)).openFlags).toBe(0);
    expect(t.db.select().from(activity).all().map((row) => row.action)).toEqual(["source.flag", "source.flag", "source.resolve_flags"]);
  });
});
