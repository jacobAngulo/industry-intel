import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb, getSqlite } from "@/lib/db/client";
import { searchStories } from "@/lib/db/fts";
import { feedSources, itemLinks, settings } from "@/lib/db/schema";
import { HttpError } from "@/lib/http/types";
import { nowMs } from "@/lib/time";

import {
  FakeHttp,
  FakeUsageMeter,
  addVote,
  installTestDb,
  linkFeedSource,
  loadFixture,
  loadJsonFixture,
  makeConnectorContext,
  makeEnv,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeStory,
  makeTopic,
  setNowForTests,
  type InstalledTestDb,
} from "./helpers";

describe("installTestDb", () => {
  it("points getDb() and getSqlite() at a temporary, migrated, unseeded database", () => {
    const t = installTestDb();
    try {
      expect(getDb()).toBe(t.db);
      expect(getSqlite()).toBe(t.sqlite);
      expect(t.file).toContain("industry-intel-test-");
      expect(getDb().select().from(settings).all()).toEqual([]);
      expect(getSqlite().prepare("SELECT count(*) FROM stories_fts").pluck().get()).toBe(0);
    } finally {
      t.cleanup();
    }
    expect(t.sqlite.open).toBe(false);
  });

  it("gives the real clock back in cleanup()", () => {
    const t = installTestDb();
    setNowForTests(1234);
    expect(nowMs()).toBe(1234);
    t.cleanup();
    expect(nowMs()).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("loadFixture", () => {
  it("reads a file from the __fixtures__ folder next to the calling test", () => {
    expect(loadFixture("sample.txt")).toBe("A sample fixture.\n");
    expect(loadJsonFixture<{ ok: boolean; n: number }>("sample.json")).toEqual({ ok: true, n: 3 });
  });

  it("reads an absolute path and a path relative to `from`", () => {
    const absolute = path.resolve("src/test/__fixtures__/sample.txt");
    expect(loadFixture(absolute)).toBe("A sample fixture.\n");
    expect(loadFixture("sample.txt", path.resolve("src/test"))).toBe("A sample fixture.\n");
    expect(loadFixture("sample.txt", path.resolve("src/test/helpers.test.ts"))).toBe("A sample fixture.\n");
  });

  it("throws a clear error for a missing file", () => {
    expect(() => loadFixture("missing.txt")).toThrow(/no file "missing.txt"/);
  });
});

describe("FakeHttp", () => {
  it("routes by exact URL, by prefix, and by a predicate, and gives 404 for an unknown URL", async () => {
    const http = new FakeHttp()
      .onPrefix("https://api.example.com/", (req) => ({ json: { path: new URL(req.url).pathname } }))
      .on("https://api.example.com/special", { status: 201, text: "special", headers: { "X-Test": "1" } })
      .on(/\/feed\.xml$/, { text: "<rss/>" })
      .on((req) => req.method === "POST", { status: 202, text: "posted" });

    const exact = await http.request({ url: "https://api.example.com/special" });
    expect(exact).toMatchObject({ status: 201, ok: true, text: "special", notModified: false });
    expect(exact.headers["x-test"]).toBe("1");

    const prefix = await http.request({ url: "https://api.example.com/v1/items" });
    expect(JSON.parse(prefix.text)).toEqual({ path: "/v1/items" });
    expect(prefix.headers["content-type"]).toBe("application/json");

    expect((await http.request({ url: "https://blog.example.com/feed.xml" })).text).toBe("<rss/>");
    expect((await http.request({ url: "https://other.example.com/x", method: "POST", body: "{}" })).status).toBe(202);

    const unknown = await http.request({ url: "https://unknown.example.com/" });
    expect(unknown).toMatchObject({ status: 404, ok: false, notModified: false, url: "https://unknown.example.com/" });

    expect(http.urls).toHaveLength(5);
    expect(http.count("https://api.example.com/special")).toBe(1);
    expect(http.count(/example\.com/)).toBe(5);
    expect(http.requests[3]).toMatchObject({ method: "POST", body: "{}" });
  });

  it("answers a conditional GET with 304 when the etag or the date is the same", async () => {
    const http = new FakeHttp()
      .on("https://example.com/a", { text: "body", etag: '"v1"' })
      .on("https://example.com/b", { text: "body", lastModified: "Thu, 19 Nov 2026 08:00:00 GMT" });

    const first = await http.request({ url: "https://example.com/a" });
    expect(first).toMatchObject({ status: 200, text: "body", etag: '"v1"', notModified: false });

    const same = await http.request({ url: "https://example.com/a", etag: first.etag });
    expect(same).toMatchObject({ status: 304, ok: false, text: "", notModified: true, etag: '"v1"' });

    const changed = await http.request({ url: "https://example.com/a", etag: '"v0"' });
    expect(changed).toMatchObject({ status: 200, text: "body" });

    const dated = await http.request({ url: "https://example.com/b", lastModified: "Thu, 19 Nov 2026 08:00:00 GMT" });
    expect(dated).toMatchObject({ status: 304, notModified: true });
    expect(dated.headers["last-modified"]).toBe("Thu, 19 Nov 2026 08:00:00 GMT");
  });

  it("throws the error of a reply, and reports a final URL", async () => {
    const http = new FakeHttp()
      .on("https://example.com/slow", { error: new HttpError("timeout", "The request took too long.") })
      .on("https://example.com/old", { text: "moved", url: "https://example.com/new" });

    await expect(http.request({ url: "https://example.com/slow" })).rejects.toMatchObject({ kind: "timeout" });
    expect((await http.request({ url: "https://example.com/old" })).url).toBe("https://example.com/new");

    http.reset();
    expect(http.requests).toEqual([]);
    expect((await http.request({ url: "https://example.com/old" })).status).toBe(404);
  });
});

describe("FakeUsageMeter and makeConnectorContext", () => {
  it("applies the limits in memory", () => {
    const usage = new FakeUsageMeter({ x_posts: 5 });
    expect(usage.take("x_posts", 3)).toBe(true);
    expect(usage.take("x_posts", 3)).toBe(false);
    expect(usage.today("x_posts")).toBe(3);
    expect(usage.remaining("x_posts")).toBe(2);
    expect(usage.remaining("llm_input_tokens")).toBe(Infinity);
    usage.add("llm_input_tokens", 1200);
    expect(usage.today("llm_input_tokens")).toBe(1200);
  });

  it("builds a context with fakes and takes overrides", () => {
    const ctx = makeConnectorContext();
    expect(ctx.http).toBeInstanceOf(FakeHttp);
    expect(ctx.env.has("X_BEARER_TOKEN")).toBe(false);
    expect(ctx.search).toBeNull();
    expect(ctx.mail).toBeNull();

    const withToken = makeConnectorContext({ env: makeEnv({ X_BEARER_TOKEN: "test-token" }), now: () => 5 });
    expect(withToken.env.has("X_BEARER_TOKEN")).toBe(true);
    expect(withToken.now()).toBe(5);
  });
});

describe("row factories", () => {
  let t: InstalledTestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.cleanup());

  it("makes rows with defaults that fit together", () => {
    setNowForTests(1_800_000_000_000);
    const topic = makeTopic({ name: "Coding agents" });
    expect(topic.slug).toMatch(/^coding-agents-\d+$/);

    const feed = makeFeed({ name: "Agentic Development", minRelevance: 70 });
    expect(feed).toMatchObject({ minRelevance: 70, halfLifeHours: 48, archivedAt: null, createdAt: 1_800_000_000_000 });
    expect(feed.digest.timeZone).toBe("UTC");

    const source = makeSource();
    expect(source.type).toBe("blog");
    expect(source.key).toMatch(/^blog:https:\/\/example\.com\/feed-\d+\.xml$/);
    expect(source.config).toMatchObject({ sections: [], authors: [], fullText: false });
    expect(source.checkIntervalMinutes).toBe(60);

    const github = makeSource({ type: "github", config: { owner: "Anthropics", repo: "Claude-Code" }, name: "Claude Code" });
    expect(github.key).toBe("github:anthropics/claude-code");
    expect(makeSource({ type: "x_user" }).key).toMatch(/^x_user:user\d+$/);
    expect(makeSource({ type: "blog", key: "custom:key", config: { anything: 1 } }).config).toEqual({ anything: 1 });

    const link = linkFeedSource(feed.id, source.id, { priority: "high", follow: "agents" });
    expect(link).toMatchObject({ feedId: feed.id, sourceId: source.id, priority: "high", follow: "agents", ignore: "" });
    expect(getDb().select().from(feedSources).all()).toHaveLength(1);

    const story = makeStory({ headline: "Claude Code adds background agents", entities: ["Claude Code"] });
    expect(searchStories('"background"', 0, 5).map((row) => row.id)).toEqual([story.id]);

    const pending = makeItem({ sourceId: source.id, links: ["https://example.com/a", "https://example.com/a"] });
    expect(pending).toMatchObject({ judgeStatus: "pending", kind: "article", storyId: null, judgeAttempts: 0 });
    expect(pending.canonicalUrl).toBe(pending.url);
    expect(getDb().select().from(itemLinks).all()).toEqual([{ itemId: pending.id, url: "https://example.com/a" }]);

    const joined = makeItem({ sourceId: source.id, storyId: story.id, kind: "release" });
    expect(joined).toMatchObject({ judgeStatus: "judged", storyId: story.id, kind: "release" });

    const judgement = makeJudgement({ feedId: feed.id, storyId: story.id, relevance: 88, topicIds: [topic.id] });
    expect(judgement).toMatchObject({ relevance: 88, baseScore: 88, hiddenReason: null, alert: false, topicIds: [topic.id] });
    const hidden = makeJudgement({ feedId: makeFeed().id, storyId: story.id, relevance: 30, hiddenReason: "below_threshold" });
    expect(hidden.hiddenReason).toBe("below_threshold");

    const a = addVote({ feedId: feed.id, storyId: story.id, reason: "useful" });
    const b = addVote({ feedId: feed.id, storyId: story.id, reason: "off_topic" });
    expect(a.userId).not.toBe(b.userId);
    expect(() => addVote({ feedId: feed.id, storyId: story.id, reason: "useful", userId: a.userId })).toThrow();
  });
});
