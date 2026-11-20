import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { FakeHttp, FakeUsageMeter, loadFixture, makeConnectorContext, makeEnv } from "@/test/helpers";

import { xUserConfigSchema } from "../configs";
import { ConnectorError, type ConnectorContext } from "../types";

import { compareIds, postLinks, postText, xPostSchema, type XRateLimitedError } from "./api";
import { connector, costNote, parseHandle, type XUserCursor } from "./index";

const TOKEN = "test-token-value-0123456789";
const LOOKUP = "https://api.x.com/2/users/by/username/";
const TWEETS = "https://api.x.com/2/users/1500000000000000001/tweets";

const json = (name: string) => JSON.parse(loadFixture(name)) as unknown;

function setup(opts: { token?: boolean; limits?: ConstructorParameters<typeof FakeUsageMeter>[0] } = {}) {
  const http = new FakeHttp();
  const usage = new FakeUsageMeter(opts.limits ?? { x_posts: 300 });
  const ctx = makeConnectorContext({
    http,
    usage,
    env: makeEnv(opts.token === false ? {} : { X_BEARER_TOKEN: TOKEN }),
  });
  return { http, usage, ctx };
}

const config = xUserConfigSchema.parse({ username: "example_dev" });

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

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

describe("x_user resolve", () => {
  const { ctx } = setup();

  it.each([
    ["@chamath", "chamath", 0.9],
    ["x.com/chamath", "chamath", 0.95],
    ["https://x.com/chamath", "chamath", 0.95],
    ["https://twitter.com/Chamath/", "Chamath", 0.95],
    ["https://www.x.com/chamath?lang=en", "chamath", 0.95],
    ["https://mobile.twitter.com/chamath", "chamath", 0.95],
    ["https://x.com/chamath/status/1990000000000000005", "chamath", 0.8],
    ["  @some_user_1  ", "some_user_1", 0.9],
  ])("finds the handle in %s", async (input, username, confidence) => {
    const [candidate, ...rest] = await connector.resolve(input, ctx, false);
    expect(rest).toHaveLength(0);
    expect(candidate).toMatchObject({ type: "x_user", name: `@${username}`, url: `https://x.com/${username}`, confidence });
    expect(xUserConfigSchema.parse(candidate!.config)).toEqual({ username, includeReposts: false });
    expect(candidate!.warnings).toBeUndefined();
  });

  it.each([
    "chamath",
    "agent workflows",
    "name@example.com",
    "@this_name_is_too_long",
    "https://x.com/home",
    "https://x.com/search?q=agents",
    "https://example.com/chamath",
    "",
    "@",
  ])("returns no candidate for %j", async (input) => {
    expect(await connector.resolve(input, ctx, false)).toEqual([]);
  });

  it("takes a bare name when the person chose the type", async () => {
    const [candidate] = await connector.resolve("chamath", ctx, true);
    expect(candidate).toMatchObject({ name: "@chamath", confidence: 0.6 });
    expect(parseHandle("two words", true)).toBeNull();
  });

  it("warns when the token is missing and makes no request", async () => {
    const { ctx: noToken, http } = setup({ token: false });
    const [candidate] = await connector.resolve("@chamath", noToken, false);
    expect(candidate!.warnings).toEqual(["Needs an X API token (X_BEARER_TOKEN)."]);
    expect(http.requests).toHaveLength(0);
  });
});

describe("x_user needs and key", () => {
  it("needs the X token", () => {
    expect(connector.needs(makeEnv({}), config)?.code).toBe("x_token");
    expect(connector.needs(makeEnv({ X_BEARER_TOKEN: TOKEN }), config)).toBeNull();
  });

  it("uses the lower-case handle as the key", () => {
    expect(connector.keyOf(xUserConfigSchema.parse({ username: "@Example_Dev" }))).toBe("x_user:example_dev");
  });
});

describe("x_user fetch: first poll", () => {
  it("looks up the user, reads the 5 newest posts, and returns the cursor", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(LOOKUP, { json: json("user-by-username.synthetic.json") });
    http.onPrefix(TWEETS, { json: json("user-tweets-first.synthetic.json") });

    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });

    expect(http.urls).toHaveLength(2);
    expect(http.urls[0]).toBe(`${LOOKUP}example_dev?user.fields=protected`);
    const tweets = params(http.urls[1]!);
    expect(tweets.get("max_results")).toBe("5");
    expect(tweets.get("exclude")).toBe("replies,retweets");
    expect(tweets.get("tweet.fields")).toContain("note_tweet");
    expect(tweets.get("tweet.fields")).toContain("public_metrics");
    expect(tweets.has("since_id")).toBe(false);
    for (const req of http.requests) expect(req.headers?.Authorization).toBe(`Bearer ${TOKEN}`);

    expect(usage.today("x_users")).toBe(1);
    expect(usage.today("x_posts")).toBe(5);
    expect(result.cursor).toEqual({ userId: "1500000000000000001", sinceId: "1990000000000000005" });

    const ids = result.items.map((item) => item.externalId);
    expect(ids).toEqual([
      "1990000000000000005",
      "1990000000000000004",
      "1990000000000000003",
      "1990000000000000002",
      "1990000000000000001",
    ]);

    const [first, long, quote, plain, release] = result.items;
    expect(first).toMatchObject({
      kind: "post",
      url: "https://x.com/Example_Dev/status/1990000000000000005",
      author: "@Example_Dev",
      publishedAt: Date.parse("2026-11-19T21:10:00.000Z"),
      links: ["https://example.com/blog/agent-runner-2"],
      meta: { likeCount: 210, repostCount: 12, replyCount: 4, quoteCount: 3 },
    });
    expect(first!.text).toBe(
      "Shipped: the agent runner now supports parallel tool calls & retries. Notes: https://example.com/blog/agent-runner-2?utm_source=x",
    );
    expect(first!.text).not.toContain("t.co");
    expect(first!.title.length).toBeLessThanOrEqual(100);
    expect(first!.title.endsWith("…")).toBe(true);

    // note_tweet gives the full text of a long post; the "show more" link to itself is not a link.
    expect(long!.text).toContain("Fourth, read the failed transcripts by hand every week.");
    expect(long!.text).toContain("https://github.com/example/eval-harness");
    expect(long!.links).toEqual(["https://github.com/example/eval-harness"]);
    expect(long!.meta).toMatchObject({ longPost: true, likeCount: 540 });

    expect(quote!.links).toEqual(["https://twitter.com/other_dev/status/1980000000000000777"]);
    expect(quote!.meta).toMatchObject({ references: [{ type: "quoted", id: "1980000000000000777" }] });
    expect(plain).toMatchObject({ title: "Good morning.", text: "Good morning.", links: [] });
    expect(release!.links).toEqual(["https://example.com/releases/v2.1"]);
  });

  it("cuts to the limit but asks for the API minimum", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(LOOKUP, { json: json("user-by-username.synthetic.json") });
    http.onPrefix(TWEETS, { json: json("user-tweets-first.synthetic.json") });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 3, ctx });
    expect(params(http.urls[1]!).get("max_results")).toBe("5");
    expect(result.items).toHaveLength(3);
    expect(usage.today("x_posts")).toBe(5);
    expect(result.cursor?.sinceId).toBe("1990000000000000005");
  });

  it("keeps reposts when includeReposts is on and drops them when it is off", async () => {
    const repost = {
      data: [
        { id: "1990000000000000021", text: "RT @other: a repost", referenced_tweets: [{ type: "retweeted", id: "1" }] },
        { id: "1990000000000000020", text: "@other a reply", referenced_tweets: [{ type: "replied_to", id: "2" }] },
        { id: "1990000000000000019", text: "An own post" },
      ],
      meta: { result_count: 3, newest_id: "1990000000000000021" },
    };
    for (const includeReposts of [false, true]) {
      const { http, ctx } = setup();
      http.onPrefix(LOOKUP, { json: json("user-by-username.synthetic.json") });
      http.onPrefix(TWEETS, { json: repost });
      const result = await connector.fetch({
        config: { username: "example_dev", includeReposts },
        cursor: null,
        mode: "poll",
        limit: 30,
        ctx,
      });
      expect(params(http.urls[1]!).get("exclude")).toBe(includeReposts ? "replies" : "replies,retweets");
      expect(result.items.map((item) => item.externalId)).toEqual(
        includeReposts ? ["1990000000000000021", "1990000000000000019"] : ["1990000000000000019"],
      );
      expect(result.cursor?.sinceId).toBe("1990000000000000021");
    }
  });
});

describe("x_user fetch: later polls", () => {
  const cursor: XUserCursor = { userId: "1500000000000000001", sinceId: "1990000000000000005" };

  it("reads only new posts with since_id and no lookup", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(TWEETS, { json: json("user-tweets-since.synthetic.json") });
    const result = await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });

    expect(http.urls).toHaveLength(1);
    const p = params(http.urls[0]!);
    expect(p.get("since_id")).toBe("1990000000000000005");
    expect(p.get("max_results")).toBe("30");
    expect(usage.today("x_users")).toBe(0);
    expect(usage.today("x_posts")).toBe(2);
    expect(result.items.map((item) => item.externalId)).toEqual(["1990000000000000012", "1990000000000000011"]);
    // The handle of the config names the URL when no lookup ran.
    expect(result.items[0]!.url).toBe("https://x.com/example_dev/status/1990000000000000012");
    expect(result.items[0]!.links).toEqual(["https://docs.example.com/changelog"]);
    expect(result.cursor).toEqual({ userId: "1500000000000000001", sinceId: "1990000000000000012" });
  });

  it("asks for no more posts than the daily limit leaves", async () => {
    const { http, ctx } = setup({ limits: { x_posts: 300 } });
    (ctx.usage as FakeUsageMeter).add("x_posts", 288);
    http.onPrefix(TWEETS, { json: json("user-tweets-since.synthetic.json") });
    await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });
    expect(params(http.urls[0]!).get("max_results")).toBe("12");
  });

  it("an old cursor with no gap sends no until_id", async () => {
    const { http, ctx } = setup();
    http.onPrefix(TWEETS, { json: json("user-tweets-since.synthetic.json") });
    await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });
    expect(params(http.urls[0]!).has("until_id")).toBe(false);
  });

  const post = (id: string) => ({ id, text: `Post ${id}.`, created_at: "2026-11-20T08:00:00.000Z" });

  it("a partial page (next_token) keeps sinceId and stores the gap below the oldest post read", async () => {
    const { http, ctx } = setup();
    http.onPrefix(TWEETS, {
      json: {
        data: [post("1990000000000000012"), post("1990000000000000011")],
        meta: { result_count: 2, newest_id: "1990000000000000012", oldest_id: "1990000000000000011", next_token: "page2" },
      },
    });
    const result = await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });
    expect(result.items.map((item) => item.externalId)).toEqual(["1990000000000000012", "1990000000000000011"]);
    expect(result.cursor).toEqual({
      userId: "1500000000000000001",
      sinceId: "1990000000000000005",
      gap: { untilId: "1990000000000000011", newest: "1990000000000000012" },
    });
  });

  it("the next poll reads the gap with since_id and until_id, then closes it", async () => {
    const withGap: XUserCursor = { ...cursor, gap: { untilId: "1990000000000000011", newest: "1990000000000000012" } };
    // Still partial: the gap moves down; the newest id stays.
    const first = setup();
    first.http.onPrefix(TWEETS, {
      json: { data: [post("1990000000000000010"), post("1990000000000000009")], meta: { oldest_id: "1990000000000000009", next_token: "p" } },
    });
    const partial = await connector.fetch({ config, cursor: withGap, mode: "poll", limit: 30, ctx: first.ctx });
    const p = params(first.http.urls[0]!);
    expect(p.get("since_id")).toBe("1990000000000000005");
    expect(p.get("until_id")).toBe("1990000000000000011");
    expect(partial.cursor).toEqual({ ...cursor, gap: { untilId: "1990000000000000009", newest: "1990000000000000012" } });

    // The last page of the gap: sinceId moves to the newest id that the app read, and the gap is gone.
    const last = setup();
    last.http.onPrefix(TWEETS, { json: { data: [post("1990000000000000008"), post("1990000000000000006")], meta: { oldest_id: "1990000000000000006" } } });
    const closed = await connector.fetch({ config, cursor: partial.cursor, mode: "poll", limit: 30, ctx: last.ctx });
    expect(params(last.http.urls[0]!).get("until_id")).toBe("1990000000000000009");
    expect(closed.items.map((item) => item.externalId)).toEqual(["1990000000000000008", "1990000000000000006"]);
    expect(closed.cursor).toEqual({ userId: "1500000000000000001", sinceId: "1990000000000000012" });

    // An empty gap also closes it.
    const empty = setup();
    empty.http.onPrefix(TWEETS, { json: json("user-tweets-empty.synthetic.json") });
    const done = await connector.fetch({ config, cursor: withGap, mode: "poll", limit: 30, ctx: empty.ctx });
    expect(done).toEqual({ items: [], cursor: { userId: "1500000000000000001", sinceId: "1990000000000000012" } });
  });

  it("returns nothing and keeps the cursor when no post is new", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(TWEETS, { json: json("user-tweets-empty.synthetic.json") });
    const result = await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });
    expect(result).toEqual({ items: [], cursor });
    expect(usage.today("x_posts")).toBe(0);
  });

  it("repeats the lookup when the cursor has no user id", async () => {
    const { http, ctx } = setup();
    http.onPrefix(LOOKUP, { json: json("user-by-username.synthetic.json") });
    http.onPrefix(TWEETS, { json: json("user-tweets-first.synthetic.json") });
    await connector.fetch({ config, cursor: { userId: "", sinceId: null }, mode: "poll", limit: 30, ctx });
    expect(http.urls[0]!.startsWith(LOOKUP)).toBe(true);
  });
});

describe("x_user fetch: preview", () => {
  it("does the lookup and 5 posts and has no cursor effect", async () => {
    const { http, usage, ctx } = setup();
    http.onPrefix(LOOKUP, { json: json("user-by-username.synthetic.json") });
    http.onPrefix(TWEETS, { json: json("user-tweets-first.synthetic.json") });
    const cursor: XUserCursor = { userId: "1500000000000000001", sinceId: "1990000000000000003" };
    const result = await connector.fetch({ config, cursor, mode: "preview", limit: 10, ctx });
    expect(http.urls).toHaveLength(2);
    expect(params(http.urls[1]!).get("max_results")).toBe("5");
    expect(params(http.urls[1]!).has("since_id")).toBe(false);
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(5);
    expect(usage.today("x_posts")).toBe(5);
  });
});

describe("x_user fetch: budget and errors", () => {
  const cursor: XUserCursor = { userId: "1500000000000000001", sinceId: "1990000000000000005" };

  it("throws budget before any request when fewer than 5 posts are left", async () => {
    const { http, ctx } = setup({ limits: { x_posts: 4 } });
    const error = await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe("budget");
    expect(http.requests).toHaveLength(0);
  });

  it("throws budget when the user lookup limit is used", async () => {
    const { http, ctx } = setup({ limits: { x_posts: 300, x_users: 0 } });
    const error = await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe("budget");
    expect(http.requests).toHaveLength(0);
  });

  it("throws needs_credentials with no request when the token is missing", async () => {
    const { http, ctx } = setup({ token: false });
    const error = await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe("needs_credentials");
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    [401, "error-401.synthetic.json", "needs_credentials"],
    [403, "error-403.synthetic.json", "needs_credentials"],
    [402, "error-402-credits.synthetic.json", "blocked"],
    [404, null, "not_found"],
    [400, null, "bad_response"],
    [500, null, "network"],
    [503, null, "network"],
  ] as const)("maps status %i to %s", async (status, fixture, kind) => {
    const { http, ctx } = setup();
    http.onPrefix(TWEETS, { status, text: fixture ? loadFixture(fixture) : "{}" });
    const error = await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe(kind);
  });

  it("maps 429 to rate_limited with the reset time", async () => {
    const { http, ctx } = setup();
    const reset = Date.parse("2026-11-20T14:05:00Z") / 1000;
    http.onPrefix(TWEETS, {
      status: 429,
      headers: { "x-rate-limit-reset": String(reset), "x-rate-limit-remaining": "0" },
      text: loadFixture("error-429.synthetic.json"),
    });
    const error = (await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }))) as XRateLimitedError;
    expect(error.kind).toBe("rate_limited");
    expect(error.message).toContain("14:05 UTC");
    expect(error.resetAt).toBe(reset * 1000);
  });

  it("maps a usage cap or a credits error in a 429 or 403 body to blocked (a failure, not the daily limit)", async () => {
    for (const [status, body] of [
      [429, { title: "UsageCapExceeded", detail: "Usage cap exceeded: Monthly product cap", type: "https://api.x.com/2/problems/usage-capped" }],
      [403, { title: "Forbidden", detail: "Your account has insufficient credits to fulfill this request." }],
    ] as const) {
      const { http, ctx } = setup();
      http.onPrefix(TWEETS, { status, json: body });
      expect((await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }))).kind).toBe("blocked");
    }
  });

  it("maps the live 402 \"credits depleted\" answer to blocked with the credits message", async () => {
    const { http, ctx } = setup();
    http.onPrefix(TWEETS, {
      status: 402,
      json: { detail: "credits depleted", status: 402, title: "Payment Required", type: "https://api.x.com/2/problems/credits-depleted" },
    });
    const error = await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe("blocked");
    expect(error.message).toBe(
      "The X API account has no credits left or reached its spending limit. Add credits in the X Developer Console.",
    );
  });

  it("maps a credits problem in a 200 body with no data to blocked", async () => {
    const { http, ctx } = setup();
    http.onPrefix(TWEETS, { json: { errors: [{ title: "CreditsDepleted", detail: "No credits left.", type: "https://api.x.com/2/problems/credits" }] } });
    expect((await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }))).kind).toBe("blocked");
  });

  it("maps an unknown user to not_found", async () => {
    const { http, ctx } = setup();
    http.onPrefix(LOOKUP, { json: json("user-not-found.synthetic.json") });
    const error = await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe("not_found");
    expect(error.message).toContain("@example_dev");
  });

  it("maps a protected account to blocked", async () => {
    const { http, ctx } = setup();
    http.onPrefix(TWEETS, { json: json("error-protected.synthetic.json") });
    expect((await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }))).kind).toBe("blocked");

    const second = setup();
    second.http.onPrefix(LOOKUP, { json: { data: { id: "1500000000000000002", username: "locked", protected: true } } });
    const error = await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: second.ctx }));
    expect(error.kind).toBe("blocked");
    expect(second.http.requests).toHaveLength(1);
  });

  it("maps HTTP failures, bad JSON, and a bad shape", async () => {
    const cases: Array<[Parameters<FakeHttp["onPrefix"]>[1], ConnectorError["kind"]]> = [
      [{ error: new HttpError("timeout", "timed out") }, "network"],
      [{ error: new HttpError("network", "reset") }, "network"],
      [{ text: "<html>not json</html>" }, "bad_response"],
      [{ json: { data: [{ id: "not-a-number", text: 5 }] } }, "bad_response"],
    ];
    for (const [reply, kind] of cases) {
      const { http, ctx } = setup();
      http.onPrefix(TWEETS, reply);
      expect((await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx }))).kind).toBe(kind);
    }
  });

  it("passes the abort signal to the request", async () => {
    const { http, ctx } = setup();
    const controller = new AbortController();
    controller.abort();
    const aborted: ConnectorContext = { ...ctx, signal: controller.signal };
    http.onPrefix(TWEETS, { json: json("user-tweets-since.synthetic.json") });
    expect((await fetchError(connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx: aborted }))).kind).toBe("network");
    expect(http.requests[0]!.signal).toBe(controller.signal);
  });
});

describe("x_user helpers", () => {
  it("compares numeric ids of different lengths", () => {
    expect(compareIds("999", "1000")).toBeLessThan(0);
    expect(compareIds("1990000000000000012", "1990000000000000005")).toBeGreaterThan(0);
    expect(compareIds("5", "5")).toBe(0);
  });

  it("drops t.co, pic, and twimg links and caps the links at 10", () => {
    const urls = Array.from({ length: 14 }, (_, i) => ({ url: `https://t.co/x${i}`, expanded_url: `https://example.com/page-${i}` }));
    urls.push({ url: "https://t.co/y", expanded_url: "https://t.co/zzz" });
    urls.push({ url: "https://t.co/p", expanded_url: "https://pbs.twimg.com/media/abc.jpg" });
    const post = xPostSchema.parse({ id: "1", text: "links", entities: { urls } });
    expect(postLinks(post)).toHaveLength(10);
    expect(postLinks(post).every((link) => link.startsWith("https://example.com/"))).toBe(true);
  });

  it("removes invisible characters and caps the text", () => {
    const post = xPostSchema.parse({ id: "2", text: `a​b ${"x".repeat(25_000)}` });
    const text = postText(post);
    expect(text.startsWith("ab ")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(20_000);
  });
});

describe("x_user costNote", () => {
  it("names the price, the first check, and the cap", () => {
    const note = costNote({ username: "chamath" }, 60);
    expect(note).toContain("Each post that the app reads costs money at X (about $0.005).");
    expect(note).toContain("@chamath");
    expect(note).toContain("about $0.05 each day");
    expect(note).toContain("about $0.04");
    expect(note).toContain("X_MAX_POSTS_PER_DAY (300 post reads each day)");
  });

  it("uses a known posting rate", () => {
    expect(costNote({ username: "chamath" }, 60, { postsPerDay: 12, maxPostsPerDay: 500 })).toContain(
      "This account: about 12 posts each day (about $0.06 each day).",
    );
  });
});
