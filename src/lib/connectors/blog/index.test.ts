import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { FakeHttp, loadFixture, makeConnectorContext } from "@/test/helpers";

import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT } from "../types";
import { probeUrls } from "./discover";
import { readFeedCursor, type FeedCursor } from "./feed-source";
import { connector, entryFilter } from "./index";

const FEED_URL = "https://devblogs.microsoft.com/foundry/feed/";
const SITE_URL = "https://devblogs.microsoft.com/foundry/";
const feedXml = loadFixture("foundry-feed.xml");
const siteHtml = loadFixture("foundry-site.html");

const baseConfig = { feedUrl: FEED_URL, sections: [], authors: [], fullText: false };

function ctxWith(http: FakeHttp) {
  return makeConnectorContext({ http, now: () => Date.UTC(2026, 10, 20) });
}

async function expectError(promise: Promise<unknown>, kind: ConnectorError["kind"], text?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).kind).toBe(kind);
  if (text) expect((error as ConnectorError).message).toMatch(text);
}

describe("blog resolve", () => {
  it("takes a feed address directly", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml });
    const found = await connector.resolve(FEED_URL, ctxWith(http), false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "blog", name: "Microsoft Foundry Blog", confidence: 0.95 });
    expect(found[0]?.config).toMatchObject({ feedUrl: FEED_URL, sections: [], authors: [], fullText: false });
    expect(connector.configSchema.safeParse(found[0]?.config).success).toBe(true);
    expect(found[0]?.description).toMatch(/Feed with 4 posts\. The newest is from/);
  });

  it("probes the common paths below the page when the page has no feed link (Foundry blog)", async () => {
    const http = new FakeHttp()
      .on(SITE_URL, { text: siteHtml })
      // The site redirects /foundry/feed to /foundry/feed/ (checked live).
      .on("https://devblogs.microsoft.com/foundry/feed", { text: feedXml, url: FEED_URL });
    const found = await connector.resolve(SITE_URL, ctxWith(http), false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Microsoft Foundry Blog", confidence: 0.8 });
    expect(found[0]?.config).toMatchObject({ feedUrl: FEED_URL, siteUrl: SITE_URL });
    expect(http.urls).toEqual([SITE_URL, "https://devblogs.microsoft.com/foundry/feed"]);
  });

  it("stops after 6 probes when no feed exists", async () => {
    const http = new FakeHttp().on(SITE_URL, { text: siteHtml }).onPrefix("https://devblogs.microsoft.com/foundry/", {
      status: 200,
      text: "<html><body>Soft 404</body></html>",
    });
    const found = await connector.resolve(SITE_URL, ctxWith(http), false);
    expect(found).toEqual([]);
    expect(http.requests).toHaveLength(7);
    expect(probeUrls(SITE_URL)).toEqual([
      "https://devblogs.microsoft.com/foundry/feed",
      "https://devblogs.microsoft.com/foundry/rss",
      "https://devblogs.microsoft.com/foundry/rss.xml",
      "https://devblogs.microsoft.com/foundry/atom.xml",
      "https://devblogs.microsoft.com/foundry/index.xml",
      "https://devblogs.microsoft.com/foundry/feed.xml",
    ]);
    expect(probeUrls("https://example.com/")[0]).toBe("https://example.com/feed");
  });

  it("follows <link rel=alternate> and uses the feed title as the name", async () => {
    const html = `<html><head><title>Site</title><link rel="alternate" type="application/rss+xml" href="/blog/feed.xml"></head></html>`;
    const http = new FakeHttp()
      .on("https://example.com/blog", { text: html })
      .on("https://example.com/blog/feed.xml", { text: feedXml });
    const found = await connector.resolve("example.com/blog", ctxWith(http), false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Microsoft Foundry Blog", confidence: 0.9 });
    expect(found[0]?.config).toMatchObject({ feedUrl: "https://example.com/blog/feed.xml" });
  });

  it("gives a comments feed a low confidence", async () => {
    const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="alternate" type="application/rss+xml" title="Comments Feed" href="/comments/feed/"></head></html>`;
    const http = new FakeHttp()
      .on("https://example.com/", { text: html })
      .on("https://example.com/feed/", { text: feedXml })
      .on("https://example.com/comments/feed/", { text: feedXml });
    const found = await connector.resolve("https://example.com/", ctxWith(http), false);
    expect(found.map((c) => c.confidence)).toEqual([0.9, 0.5]);
  });

  it("returns [] for input that is not an address, with no request", async () => {
    const http = new FakeHttp();
    for (const input of ["agent evaluation", "@chamath", "news@example.com", "", "   ", "ftp://example.com/feed"]) {
      expect(await connector.resolve(input, ctxWith(http), false)).toEqual([]);
    }
    expect(http.requests).toHaveLength(0);
  });

  it("leaves the hosts of other types alone unless the type is forced", async () => {
    const http = new FakeHttp().on("https://github.com/anthropics/claude-code", { text: "<html></html>" });
    expect(await connector.resolve("https://github.com/anthropics/claude-code", ctxWith(http), false)).toEqual([]);
    expect(http.requests).toHaveLength(0);
    await connector.resolve("https://github.com/anthropics/claude-code", ctxWith(http), true);
    expect(http.requests.length).toBeGreaterThan(0);
  });

  it("marks a podcast feed with a warning and a low confidence", async () => {
    const http = new FakeHttp().on("https://feeds.example.com/show.xml", { text: loadFixture("../../podcast/__fixtures__/all-in-feed.xml") });
    const found = await connector.resolve("https://feeds.example.com/show.xml", ctxWith(http), false);
    expect(found[0]?.confidence).toBeLessThanOrEqual(0.4);
    expect(found[0]?.warnings?.[0]).toMatch(/podcast/i);
  });

  it("throws a plain error when the address does not answer", async () => {
    const http = new FakeHttp().on("https://example.com/gone", { status: 404, text: "no" });
    await expectError(connector.resolve("https://example.com/gone", ctxWith(http), false), "not_found", /404/);
  });
});

describe("blog fetch", () => {
  it("first poll: the newest items, plain text, stable ids, and a cursor with the validators", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml, etag: '"v1"', lastModified: "Fri, 20 Nov 2026 06:46:27 GMT" });
    const result = await connector.fetch({ config: baseConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(4);
    const times = result.items.map((i) => i.publishedAt ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const item of result.items) {
      expect(item.kind).toBe("article");
      expect(item.text).not.toMatch(/<\/?(p|div|a|img)\b/i);
      expect(item.text.length).toBeLessThanOrEqual(RAW_ITEM_MAX_TEXT);
      expect(item.links?.length ?? 0).toBeLessThanOrEqual(RAW_ITEM_MAX_LINKS);
      for (const link of item.links ?? []) expect(link).toMatch(/^https?:\/\//);
      expect(item.url).toMatch(/^https:\/\/devblogs\.microsoft\.com\/foundry\//);
      expect(item.author).toBeTruthy();
    }
    expect(result.items[0]?.externalId).toBe("https://devblogs.microsoft.com/foundry/?p=3401");
    expect(result.cursor).toMatchObject({ etag: '"v1"', lastModified: "Fri, 20 Nov 2026 06:46:27 GMT" });
    expect(result.cursor?.seenIds).toHaveLength(4);
  });

  it("caps the first poll at `limit`", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml });
    const result = await connector.fetch({ config: baseConfig, cursor: null, mode: "poll", limit: 2, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(2);
    // All entries of the window count as seen, so the older two do not come back later.
    expect(result.cursor?.seenIds).toHaveLength(4);
  });

  it("a later poll returns only the entries that the cursor has not seen", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml });
    const first = await connector.fetch({ config: baseConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    const newest = first.items[0]!;
    const cursor: FeedCursor = { seenIds: first.cursor!.seenIds.filter((id) => id !== newest.externalId) };
    const later = await connector.fetch({ config: baseConfig, cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(later.items.map((i) => i.externalId)).toEqual([newest.externalId]);
    expect(later.cursor?.seenIds[0]).toBe(newest.externalId);
    const again = await connector.fetch({ config: baseConfig, cursor: later.cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(again.items).toEqual([]);
  });

  it("uses the conditional GET: 304 gives no items and keeps the cursor", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml, etag: '"v1"' });
    const cursor: FeedCursor = { etag: '"v1"', seenIds: ["a", "b"] };
    const result = await connector.fetch({ config: baseConfig, cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(http.requests[0]?.etag).toBe('"v1"');
    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual({ etag: '"v1"', seenIds: ["a", "b"] });
  });

  it("preview: no conditional GET, no cursor effect", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml, etag: '"v1"' });
    const cursor: FeedCursor = { etag: '"v1"', seenIds: [] };
    const result = await connector.fetch({ config: baseConfig, cursor, mode: "preview", limit: 3, ctx: ctxWith(http) });
    expect(http.requests[0]?.etag).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(result.cursor).toBeNull();
  });

  it("filters by section (entry category, no case difference)", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml });
    const config = { ...baseConfig, sections: ["hosted agents"] };
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThan(4);
    for (const item of result.items) {
      expect((item.meta?.categories as string[]).map((c) => c.toLowerCase())).toContain("hosted agents");
    }
    // Entries that the filter drops still count as seen.
    expect(result.cursor?.seenIds).toHaveLength(4);
  });

  it("filters by author, also inside a list of authors", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: feedXml });
    const result = await connector.fetch({
      config: { ...baseConfig, authors: ["EAMON O'REILLY"] },
      cursor: null,
      mode: "poll",
      limit: 30,
      ctx: ctxWith(http),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.author).toMatch(/Eamon O'Reilly/);
    const none = await connector.fetch({ config: { ...baseConfig, authors: ["Nobody"] }, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(none.items).toEqual([]);
  });

  it("entryFilter: empty lists keep everything", () => {
    const keep = entryFilter({ sections: [], authors: [] });
    expect(keep({ id: "x", title: "t", text: "", categories: [], extra: {} })).toBe(true);
  });

  it("fullText: fetches the page of short entries, at most 5 for each poll", async () => {
    const http = new FakeHttp()
      .on("https://blog.example.com/feed", { text: loadFixture("short-entries.synthetic.xml") })
      .onPrefix("https://blog.example.com/posts/", { text: loadFixture("article.synthetic.html") });
    const config = { ...baseConfig, feedUrl: "https://blog.example.com/feed", fullText: true };
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(7);
    expect(http.count(/\/posts\//)).toBe(5);
    expect(result.items[0]?.text).toMatch(/new runner/);
    expect(result.items[0]?.meta?.fullText).toBe(true);
    expect(result.items[6]?.text).toMatch(/Short teaser number 1/);
    const preview = await connector.fetch({ config, cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http.reset().on("https://blog.example.com/feed", { text: loadFixture("short-entries.synthetic.xml") }).onPrefix("https://blog.example.com/posts/", { text: loadFixture("article.synthetic.html") })) });
    expect(preview.items).toHaveLength(7);
    expect(http.count(/\/posts\//)).toBe(2);
  });

  it("fullText: a page that fails keeps the feed text", async () => {
    const http = new FakeHttp()
      .on("https://blog.example.com/feed", { text: loadFixture("short-entries.synthetic.xml") })
      .onPrefix("https://blog.example.com/posts/", { error: new HttpError("timeout", "slow") });
    const config = { ...baseConfig, feedUrl: "https://blog.example.com/feed", fullText: true };
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items[0]?.text).toMatch(/Short teaser number 7/);
  });

  it.each([
    [{ status: 404 }, "not_found", /returned 404/],
    [{ status: 410 }, "not_found", /410/],
    [{ status: 403 }, "blocked", /refused/],
    [{ status: 429 }, "rate_limited", /slow down/],
    [{ status: 503 }, "network", /503/],
    [{ status: 418 }, "bad_response", /418/],
    [{ text: "<html><body>Not a feed</body></html>" }, "bad_response", /did not return a feed/],
    [{ error: new HttpError("timeout", "t") }, "network", /in time/],
    [{ error: new HttpError("network", "n") }, "network", /could not reach/],
    [{ error: new HttpError("blocked_address", "b") }, "blocked", /private or local/],
    [{ error: new HttpError("too_large", "l") }, "bad_response", /size limit/],
    [{ error: new HttpError("too_many_redirects", "r") }, "bad_response", /redirects/],
    [{ error: new HttpError("bad_url", "u") }, "not_found", /not a valid/],
  ] as const)("maps %o to %s", async (reply, kind, text) => {
    const http = new FakeHttp().on(FEED_URL, reply);
    await expectError(connector.fetch({ config: baseConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }), kind, text);
  });

  it("odd input: a cursor of another shape counts as no cursor; limit 0 gives no items", async () => {
    expect(readFeedCursor({ uidValidity: 1 })).toEqual({ seenIds: [] });
    expect(readFeedCursor("garbage")).toBeNull();
    expect(readFeedCursor({ seenIds: "x" })).toBeNull();
    const http = new FakeHttp().on(FEED_URL, { text: feedXml });
    const odd = await connector.fetch({ config: baseConfig, cursor: "garbage" as unknown as FeedCursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(odd.items).toHaveLength(4);
    const none = await connector.fetch({ config: baseConfig, cursor: null, mode: "poll", limit: 0, ctx: ctxWith(http) });
    expect(none.items).toEqual([]);
  });

  it("an empty feed gives no items", async () => {
    const http = new FakeHttp().on(FEED_URL, { text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>` });
    const result = await connector.fetch({ config: baseConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual({ seenIds: [] });
  });

  it("keyOf and needs", () => {
    expect(connector.keyOf(connector.configSchema.parse({ feedUrl: "https://Example.com/feed/" }))).toBe("blog:https://example.com/feed");
    expect(connector.needs(makeConnectorContext().env)).toBeNull();
  });
});
