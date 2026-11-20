import { describe, expect, it } from "vitest";

import { FakeHttp, FakeUsageMeter, loadFixture, makeConnectorContext, makeEnv } from "@/test/helpers";

import { xSearchConfigSchema } from "../configs";
import { ConnectorError } from "../types";
import { xPostSchema } from "../x_user/api";

import { buildSearchQuery, connector, costNote, parseKeyword, selectTopPosts, type XSearchCursor } from "./index";

const TOKEN = "test-token-value-0123456789";
const SEARCH = "https://api.x.com/2/tweets/search/recent";
const NOW = Date.parse("2026-11-20T12:00:00Z");
const HOUR = 3_600_000;

const fixture = () => JSON.parse(loadFixture("search-recent.synthetic.json")) as unknown;

function setup(opts: { token?: boolean; limits?: ConstructorParameters<typeof FakeUsageMeter>[0]; now?: number } = {}) {
  const http = new FakeHttp();
  const usage = new FakeUsageMeter(opts.limits ?? { x_posts: 300 });
  const ctx = makeConnectorContext({
    http,
    usage,
    now: () => opts.now ?? NOW,
    env: makeEnv(opts.token === false ? {} : { X_BEARER_TOKEN: TOKEN }),
  });
  return { http, usage, ctx };
}

const config = xSearchConfigSchema.parse({ query: "coding agent evals" });
const params = (url: string) => new URL(url).searchParams;

async function fetchError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as Error).message).not.toContain(TOKEN);
    return error as ConnectorError;
  }
  throw new Error("expected a ConnectorError");
}

describe("x_search resolve", () => {
  const { ctx, http } = setup();

  it("is a low-confidence candidate for plain topic text", async () => {
    const [candidate] = await connector.resolve("coding agent evals", ctx, false);
    expect(candidate).toMatchObject({ type: "x_search", name: "X: coding agent evals", confidence: 0.3 });
    expect(candidate!.config).toEqual({ query: "coding agent evals", lang: "en", minLikes: 10, maxPostsPerRun: 20, keepTop: 3 });
    expect(candidate!.description).toContain("at least 10 likes");
    expect(candidate!.url).toBe("https://x.com/search?q=coding%20agent%20evals&f=top");
  });

  it("is sure when the person chose the type, or for a hint or an X search link", async () => {
    expect((await connector.resolve("coding agents", ctx, true))[0]!.confidence).toBe(0.9);
    expect((await connector.resolve("x: coding agents", ctx, false))[0]).toMatchObject({ confidence: 0.85, config: { query: "coding agents" } });
    expect((await connector.resolve("https://x.com/search?q=claude%20code&src=typed_query", ctx, false))[0]).toMatchObject({
      confidence: 0.95,
      config: { query: "claude code" },
    });
    expect((await connector.resolve("#agents", ctx, false))[0]!.confidence).toBe(0.5);
  });

  it.each(["", "a", "@chamath", "https://example.com/blog", "example.com", "news@example.com", "line one\nline two", "https://x.com/search?f=top"])(
    "returns no candidate for %j",
    async (input) => {
      expect(await connector.resolve(input, ctx, false)).toEqual([]);
    },
  );

  it("takes an @handle as a query only when forced, and rejects a query that is too long", async () => {
    expect(parseKeyword("@chamath", true)).toEqual({ query: "@chamath", confidence: 0.5 });
    expect(await connector.resolve("x".repeat(400), ctx, true)).toEqual([]);
  });

  it("warns about the missing token and makes no request", async () => {
    const noToken = setup({ token: false });
    expect((await connector.resolve("agents", noToken.ctx, false))[0]!.warnings).toEqual(["Needs an X API token (X_BEARER_TOKEN)."]);
    expect(http.requests).toHaveLength(0);
    expect(noToken.http.requests).toHaveLength(0);
  });
});

describe("x_search needs, key, and query", () => {
  it("needs the token and keys on query and language", () => {
    expect(connector.needs(makeEnv({}), config)?.code).toBe("x_token");
    expect(connector.keyOf(xSearchConfigSchema.parse({ query: "  Coding   Agent Evals " }))).toBe("x_search:coding agent evals|en");
  });

  it("adds the fixed operators", () => {
    expect(buildSearchQuery({ query: "claude OR codex", lang: "EN" })).toBe("(claude OR codex) -is:retweet -is:reply lang:en");
  });
});

describe("x_search fetch", () => {
  it("first poll: the last 24 h up to now - 2 h, relevancy, then minLikes and keepTop in code", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(SEARCH, { json: fixture() });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });

    expect(http.urls).toHaveLength(1);
    const p = params(http.urls[0]!);
    expect(p.get("query")).toBe("(coding agent evals) -is:retweet -is:reply lang:en");
    expect(p.get("sort_order")).toBe("relevancy");
    expect(p.get("max_results")).toBe("20");
    expect(p.get("start_time")).toBe("2026-11-19T12:00:00Z");
    expect(p.get("end_time")).toBe("2026-11-20T10:00:00Z");
    expect(p.get("expansions")).toBe("author_id");
    expect(p.get("user.fields")).toBe("username");
    expect(p.get("tweet.fields")).toContain("public_metrics");
    expect(http.requests[0]!.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(usage.today("x_posts")).toBe(5);

    // Likes: 900, 320, 60, 55 pass minLikes 10 (4 does not); keepTop 3 -> 900, 320, 60; newest first.
    expect(result.items.map((item) => item.externalId)).toEqual(["1990000000000000304", "1990000000000000303", "1990000000000000301"]);
    expect(result.items[1]).toMatchObject({
      url: "https://x.com/eval_lab/status/1990000000000000303",
      author: "@eval_lab",
      links: ["https://arxiv.org/abs/2611.00001"],
      meta: { likeCount: 900, repostCount: 80, replyCount: 20, quoteCount: 15, query: "coding agent evals" },
    });
    expect(result.cursor).toEqual({ lastEndTime: NOW - 2 * HOUR });
  });

  it("later poll: starts at the end of the last run", async () => {
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { json: fixture() });
    const cursor: XSearchCursor = { lastEndTime: NOW - 14 * HOUR };
    const result = await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });
    expect(params(http.urls[0]!).get("start_time")).toBe("2026-11-19T22:00:00Z");
    expect(result.cursor).toEqual({ lastEndTime: NOW - 2 * HOUR });
  });

  it("keeps the start inside the 7 days of the recent search", async () => {
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { json: { meta: { result_count: 0 } } });
    await connector.fetch({ config, cursor: { lastEndTime: NOW - 30 * 24 * HOUR }, mode: "poll", limit: 30, ctx });
    const start = Date.parse(params(http.urls[0]!).get("start_time")!);
    expect(start).toBeGreaterThan(NOW - 7 * 24 * HOUR);
  });

  it("makes no request when the window is empty, and keeps the cursor", async () => {
    const { http, ctx } = setup();
    const cursor: XSearchCursor = { lastEndTime: NOW - 2 * HOUR };
    expect(await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx })).toEqual({ items: [], cursor });
    expect(http.requests).toHaveLength(0);
  });

  it("an empty result moves the cursor and costs nothing", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(SEARCH, { json: { meta: { result_count: 0 } } });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });
    expect(result).toEqual({ items: [], cursor: { lastEndTime: NOW - 2 * HOUR } });
    expect(usage.today("x_posts")).toBe(0);
  });

  it("applies minLikes 0 and keepTop of the config", async () => {
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { json: fixture() });
    const result = await connector.fetch({
      config: { ...config, minLikes: 0, keepTop: 20, maxPostsPerRun: 50 },
      cursor: null,
      mode: "poll",
      limit: 30,
      ctx,
    });
    expect(params(http.urls[0]!).get("max_results")).toBe("50");
    expect(result.items).toHaveLength(5);
    expect(result.items[0]!.externalId).toBe("1990000000000000305");
  });

  it("drops reposts and replies that the search returned", () => {
    const posts = [
      { id: "3", text: "RT @a: x", public_metrics: { like_count: 100 } },
      { id: "2", text: "reply", referenced_tweets: [{ type: "replied_to", id: "1" }], public_metrics: { like_count: 100 } },
      { id: "1", text: "own", public_metrics: { like_count: 100 } },
    ];
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { json: { data: posts, meta: { result_count: 3 } } });
    return connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }).then((result) => {
      expect(result.items.map((item) => item.externalId)).toEqual(["1"]);
      // No author in includes: the generic post link.
      expect(result.items[0]!.url).toBe("https://x.com/i/web/status/1");
      expect(result.items[0]!.author).toBeUndefined();
    });
  });

  it("preview: 10 posts (the API minimum), no cursor effect", async () => {
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { json: fixture() });
    const result = await connector.fetch({ config, cursor: { lastEndTime: NOW - 3 * HOUR }, mode: "preview", limit: 10, ctx });
    const p = params(http.urls[0]!);
    expect(p.get("max_results")).toBe("10");
    expect(p.get("start_time")).toBe("2026-11-19T12:00:00Z");
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(3);
  });

  it("asks for no more posts than the daily limit leaves, and throws budget below 10", async () => {
    const low = setup({ limits: { x_posts: 15 } });
    low.http.onPrefix(SEARCH, { json: fixture() });
    await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: low.ctx });
    expect(params(low.http.urls[0]!).get("max_results")).toBe("15");

    const none = setup({ limits: { x_posts: 9 } });
    const error = await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: none.ctx }));
    expect(error.kind).toBe("budget");
    expect(none.http.requests).toHaveLength(0);
  });

  it.each([
    [401, "needs_credentials"],
    [403, "needs_credentials"],
    [402, "blocked"],
    [429, "rate_limited"],
    [400, "bad_response"],
    [502, "network"],
  ] as const)("maps status %i to %s", async (status, kind) => {
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { status, json: { title: "Error", detail: "Invalid query" } });
    expect((await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }))).kind).toBe(kind);
  });

  it("needs the token", async () => {
    const { http, ctx } = setup({ token: false });
    expect((await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }))).kind).toBe("needs_credentials");
    expect(http.requests).toHaveLength(0);
  });

  it("rejects a bad response shape", async () => {
    const { http, ctx } = setup();
    http.onPrefix(SEARCH, { json: { data: "nope" } });
    expect((await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }))).kind).toBe("bad_response");
  });
});

describe("x_search helpers", () => {
  it("selectTopPosts keeps the search order for equal likes", () => {
    const posts = ["1", "2", "3"].map((id) => xPostSchema.parse({ id, text: id, public_metrics: { like_count: 10 } }));
    expect(selectTopPosts(posts, 10, 2).map((post) => post.id)).toEqual(["1", "2"]);
    expect(selectTopPosts(posts, 11, 2)).toEqual([]);
  });

  it("costNote follows §6.3", () => {
    expect(costNote({ maxPostsPerRun: 20 }, 720)).toBe(
      "Each run reads up to 20 posts. At 2 runs each day that is up to 40 post reads (about $0.20) for this keyword. The app stops at X_MAX_POSTS_PER_DAY (300 post reads each day).",
    );
    expect(costNote({ maxPostsPerRun: 50 }, 1440, { maxPostsPerDay: 500 })).toContain("At 1 run each day that is up to 50 post reads (about $0.25)");
    expect(costNote({ maxPostsPerRun: 20 }, 1000)).toContain("At about 1.4 runs each day");
  });
});
