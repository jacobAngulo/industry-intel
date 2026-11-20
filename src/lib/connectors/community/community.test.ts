import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpError, type HttpRequest } from "@/lib/http/types";
import { FakeHttp, loadFixture, makeConnectorContext, makeEnv } from "@/test/helpers";

import { parseConfig, type CommunityConfig } from "../configs";
import { ConnectorError, type ConnectorContext } from "../types";
import { discourseListUrl, parseDiscoursePath } from "./discourse";
import { connector } from "./index";
import { clearRedditTokensForTests, REDDIT_BLOCKED_MESSAGE } from "./reddit";
import type { CommunityCursor } from "./shared";

// The HN fixtures were captured at about this time (2026-11-20T08:15Z).
const NOW = 1_795_176_906_000;

const hnSearch = loadFixture("hn-search.json");
const hnFront = loadFixture("hn-front.json");
const hfLatest = loadFixture("discourse-hf-latest.json");
const hfTopic = loadFixture("discourse-hf-topic.json");
const hfCategoryPage = loadFixture("discourse-hf-category-page.html");
const openaiCategory = loadFixture("discourse-openai-category.json");
const redditTop = loadFixture("reddit-top.synthetic.json");
const redditToken = loadFixture("reddit-token.synthetic.json");
const reddit403 = loadFixture("reddit-403.synthetic.html");

function ctxWith(http: FakeHttp, extra: Partial<ConnectorContext> = {}): ConnectorContext {
  return makeConnectorContext({ http, now: () => NOW, ...extra });
}

const cfg = (value: unknown) => parseConfig("community", value) as CommunityConfig;

async function expectError(promise: Promise<unknown>, kind: ConnectorError["kind"], message?: string | RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).kind).toBe(kind);
  if (message !== undefined) {
    if (typeof message === "string") expect((error as ConnectorError).message).toBe(message);
    else expect((error as ConnectorError).message).toMatch(message);
  }
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe("community resolve", () => {
  it("news.ycombinator.com is the front page", async () => {
    const http = new FakeHttp();
    const [c, ...rest] = await connector.resolve("https://news.ycombinator.com/", ctxWith(http), false);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ type: "community", name: "Hacker News front page", confidence: 0.95 });
    expect(c!.config).toEqual({ variant: "hn", query: null, minPoints: 50, minComments: 0 });
    expect(connector.configSchema.parse(c!.config)).toEqual(c!.config);
    expect(http.requests).toHaveLength(0);
  });

  it("an HN thread link gives the front page with a low confidence and a warning", async () => {
    const [c] = await connector.resolve("news.ycombinator.com/item?id=50549188", ctxWith(new FakeHttp()), false);
    expect(c!.confidence).toBeLessThan(0.5);
    expect(c!.warnings?.[0]).toMatch(/one Hacker News thread/);
  });

  it("an hn.algolia.com search link gives the query", async () => {
    const [c] = await connector.resolve("https://hn.algolia.com/?dateRange=pastWeek&query=coding%20agent&type=story", ctxWith(new FakeHttp()), false);
    expect(c!.config).toMatchObject({ variant: "hn", query: "coding agent" });
    expect(c!.name).toBe('Hacker News: "coding agent"');
  });

  it('"hn: words" and "hn"', async () => {
    const ctx = ctxWith(new FakeHttp());
    const [a] = await connector.resolve("hn: coding agent", ctx, false);
    expect(a).toMatchObject({ confidence: 0.95, config: { variant: "hn", query: "coding agent" } });
    const [b] = await connector.resolve('Hacker News: "agent evals"', ctx, false);
    expect(b!.config).toMatchObject({ query: "agent evals" });
    const [c] = await connector.resolve("HN", ctx, false);
    expect(c!.config).toMatchObject({ query: null });
  });

  it("plain text is a low-confidence HN search; forced, it is higher and one word adds a subreddit guess", async () => {
    const http = new FakeHttp();
    const plain = await connector.resolve("agent evaluation", ctxWith(http), false);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ confidence: 0.3, config: { variant: "hn", query: "agent evaluation" } });

    const forced = await connector.resolve("agent evaluation", ctxWith(http), true);
    expect(forced).toHaveLength(1);
    expect(forced[0]!.confidence).toBe(0.7);

    const word = await connector.resolve("LocalLLaMA", ctxWith(http), true);
    expect(word.map((c) => (c.config as CommunityConfig).variant)).toEqual(["hn", "reddit"]);
    expect(word[1]!.confidence).toBeLessThan(0.5);
    expect(http.requests).toHaveLength(0);
  });

  it("r/name and reddit links; the warning goes when the credentials are set", async () => {
    const ctx = ctxWith(new FakeHttp());
    const [a] = await connector.resolve("r/LocalLLaMA", ctx, false);
    expect(a).toMatchObject({ name: "r/LocalLLaMA", confidence: 0.95 });
    expect(a!.config).toEqual({ variant: "reddit", subreddit: "LocalLLaMA", listing: "top_day", minScore: 50 });
    expect(a!.warnings?.[0]).toMatch(/REDDIT_CLIENT_ID/);

    const [b] = await connector.resolve("https://old.reddit.com/r/ClaudeAI/new/", ctx, false);
    expect(b!.config).toMatchObject({ subreddit: "ClaudeAI", listing: "new" });
    const [c] = await connector.resolve("https://www.reddit.com/r/LocalLLaMA/comments/abc/some_title/", ctx, false);
    expect(c!.config).toMatchObject({ subreddit: "LocalLLaMA", listing: "top_day" });
    expect(await connector.resolve("https://www.reddit.com/user/someone", ctx, false)).toEqual([]);

    const withKeys = ctxWith(new FakeHttp(), { env: makeEnv({ REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "secret" }) });
    const [d] = await connector.resolve("/r/LocalLLaMA", withKeys, false);
    expect(d!.warnings).toBeUndefined();
  });

  it("a Discourse category link: one request, the category slug and id from the path", async () => {
    const http = new FakeHttp().on("https://discuss.huggingface.co/c/transformers/9", { text: hfCategoryPage });
    const [c, ...rest] = await connector.resolve("https://discuss.huggingface.co/c/transformers/9", ctxWith(http), false);
    expect(rest).toEqual([]);
    expect(http.requests).toHaveLength(1);
    expect(c).toMatchObject({ type: "community", name: "Hugging Face Forums: 🤗Transformers", confidence: 0.9 });
    expect(c!.config).toEqual({ variant: "discourse", baseUrl: "https://discuss.huggingface.co", categorySlug: "transformers", categoryId: 9 });
    expect(connector.configSchema.parse(c!.config)).toEqual(c!.config);
  });

  it("a Discourse root link, a tag link, and a topic link", async () => {
    const http = new FakeHttp().onPrefix("https://community.openai.com/", { text: hfCategoryPage.replace("Latest 🤗Transformers topics - ", "") });
    const ctx = ctxWith(http);
    const [root] = await connector.resolve("https://community.openai.com", ctx, false);
    expect(root!.config).toEqual({ variant: "discourse", baseUrl: "https://community.openai.com" });
    const [tag] = await connector.resolve("https://community.openai.com/tag/codex", ctx, false);
    expect(tag!.config).toEqual({ variant: "discourse", baseUrl: "https://community.openai.com", tag: "codex" });
    const [topic] = await connector.resolve("https://community.openai.com/t/some-topic/1417548", ctx, false);
    expect(topic!.config).toEqual({ variant: "discourse", baseUrl: "https://community.openai.com" });
    expect(topic!.confidence).toBe(0.6);
    expect(topic!.warnings).toHaveLength(1);
  });

  it("a forum-like page that is not Discourse gives []", async () => {
    const http = new FakeHttp().on("https://forum.example.com/", { text: "<html><head><title>Forum</title></head></html>" });
    expect(await connector.resolve("https://forum.example.com/", ctxWith(http), false)).toEqual([]);
  });

  it("an ordinary link makes no request unless the type is forced", async () => {
    const http = new FakeHttp().onPrefix("https://blog.example.com/", { text: "<html></html>" });
    expect(await connector.resolve("https://blog.example.com/post", ctxWith(http), false)).toEqual([]);
    expect(http.requests).toHaveLength(0);
    expect(await connector.resolve("https://blog.example.com/post", ctxWith(http), true)).toEqual([]);
    expect(http.requests).toHaveLength(1);
    expect(await connector.resolve("https://github.com/anthropics/claude-code", ctxWith(http), true)).toEqual([]);
    expect(http.requests).toHaveLength(1);
  });

  it("a failed request in resolve gives []", async () => {
    const http = new FakeHttp().onPrefix("https://forum.example.com/", { error: new HttpError("timeout", "slow") });
    expect(await connector.resolve("https://forum.example.com/c/agents/4", ctxWith(http), false)).toEqual([]);
  });

  it("odd input gives []", async () => {
    const ctx = ctxWith(new FakeHttp());
    for (const input of ["", "   ", "@chamath", "news@example.com", "!!!", "x".repeat(400)]) {
      expect(await connector.resolve(input, ctx, false)).toEqual([]);
    }
  });
});

describe("parseDiscoursePath and discourseListUrl", () => {
  it("reads the base path and the category forms", () => {
    expect(parseDiscoursePath(new URL("https://example.com/forum/c/agents/evals/12/l/latest"))).toEqual({
      base: "https://example.com/forum",
      route: "category",
      categorySlug: "agents/evals",
      categoryId: 12,
    });
    expect(parseDiscoursePath(new URL("https://example.com/c/39"))).toMatchObject({ route: "category", categoryId: 39 });
    expect(parseDiscoursePath(new URL("https://example.com/c/agents"))).toMatchObject({ route: "category", categorySlug: "agents" });
    expect(parseDiscoursePath(new URL("https://example.com/latest"))).toEqual({ base: "https://example.com", route: "root" });
    expect(parseDiscoursePath(new URL("https://example.com/forum"))).toEqual({ base: "https://example.com/forum", route: "root" });
  });

  it("builds the list endpoints", () => {
    const base = { variant: "discourse" as const, baseUrl: "https://f.example.com/" };
    expect(discourseListUrl(base)).toBe("https://f.example.com/latest.json?order=created");
    expect(discourseListUrl({ ...base, categorySlug: "codex/codex-cli", categoryId: 39 })).toBe(
      "https://f.example.com/c/codex/codex-cli/39.json?order=created",
    );
    expect(discourseListUrl({ ...base, categoryId: 39 })).toBe("https://f.example.com/c/39.json?order=created");
    expect(discourseListUrl({ ...base, categorySlug: "agents" })).toBe("https://f.example.com/c/agents.json?order=created");
    expect(discourseListUrl({ ...base, tag: "a b" })).toBe("https://f.example.com/tag/a%20b.json?order=created");
  });
});

// ---------------------------------------------------------------------------
// fetch: Hacker News
// ---------------------------------------------------------------------------

describe("community fetch: hn", () => {
  const query = cfg({ variant: "hn", query: "coding agent", minPoints: 50 });

  it("first poll: the request, the threshold in code, newest first, the item fields, the cursor", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/api/v1/search_by_date?", { text: hnSearch });
    const result = await connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });

    const url = new URL(http.urls[0]!);
    expect(url.searchParams.get("query")).toBe("coding agent");
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("numericFilters")).toBe(`points>=50,num_comments>=0,created_at_i>${NOW / 1000 - 3 * 86400}`);

    // The fixture has one story with 25 points: the connector drops it.
    expect(result.items.map((i) => i.externalId)).toEqual(["50549188", "50548660", "50538303", "50536468", "50533270"]);
    const times = result.items.map((i) => i.publishedAt!);
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const text = result.items[0]!;
    expect(text.kind).toBe("discussion");
    expect(text.url).toBe("https://news.ycombinator.com/item?id=50549188");
    expect(text.text.startsWith("Launch HN: Maritime")).toBe(true);
    expect(text.text).not.toMatch(/<a |&#x27;/);
    expect(text.links).toContain("https://maritime.sh/");
    expect(text.meta).toMatchObject({ points: 60, comments: 63 });

    const article = result.items.find((i) => i.externalId === "50538303")!;
    expect(article.url).toMatch(/^https:\/\/complexdiscovery\.com\//);
    expect(article.links).toEqual([article.url!.replace(/\/$/, ""), "https://news.ycombinator.com/item?id=50538303"]);

    for (const item of result.items) {
      expect(item.text.length).toBeLessThanOrEqual(20_000);
      expect(item.links!.length).toBeLessThanOrEqual(10);
    }
    expect(result.cursor).toEqual({ variant: "hn", seenIds: ["50549188", "50548660", "50538303", "50536468", "50533270"] });
  });

  it("minComments filters in code", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", { text: hnSearch });
    const config = cfg({ variant: "hn", query: "coding agent", minPoints: 50, minComments: 50 });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.externalId)).toEqual(["50549188", "50538303", "50536468"]);
  });

  it("a first poll returns at most `limit` items but counts all of them as seen", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", { text: hnSearch });
    const result = await connector.fetch({ config: query, cursor: null, mode: "poll", limit: 2, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(2);
    expect(result.cursor!.seenIds).toHaveLength(5);
  });

  it("a later poll returns only the stories that the cursor has not seen", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", { text: hnSearch });
    const cursor: CommunityCursor = { variant: "hn", seenIds: ["50548660", "50538303", "50536468", "50533270", "1"] };
    const result = await connector.fetch({ config: query, cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.externalId)).toEqual(["50549188"]);
    expect(result.cursor!.seenIds[0]).toBe("50549188");
    expect(result.cursor!.seenIds).toContain("1");
  });

  it("a cursor of another variant counts as no cursor", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", { text: hnSearch });
    const result = await connector.fetch({
      config: query,
      cursor: { variant: "reddit", seenIds: ["50549188"] } as CommunityCursor,
      mode: "poll",
      limit: 30,
      ctx: ctxWith(http),
    });
    expect(result.items).toHaveLength(5);
  });

  it("the front page: the search endpoint with tags=front_page; stories older than 3 days drop", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/api/v1/search?", { text: hnFront });
    const result = await connector.fetch({ config: cfg({ variant: "hn" }), cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(new URL(http.urls[0]!).searchParams.get("tags")).toBe("front_page");
    expect(result.items).toHaveLength(11);
    expect(result.items.some((i) => i.externalId === "50528119")).toBe(false);
    expect(result.items[0]!.externalId).toBe("50571189");
  });

  it("preview: no cursor, a small request", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", { text: hnSearch });
    const result = await connector.fetch({
      config: query,
      cursor: { variant: "hn", seenIds: ["50549188"] },
      mode: "preview",
      limit: 3,
      ctx: ctxWith(http),
    });
    expect(result.cursor).toBeNull();
    expect(result.items.map((i) => i.externalId)).toEqual(["50549188", "50548660", "50538303"]);
    expect(new URL(http.urls[0]!).searchParams.get("hitsPerPage")).toBe("3");
  });

  it("not modified: a 304 keeps the cursor and returns nothing", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", { text: hnSearch, etag: '"v1"' });
    const first = await connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(first.cursor!.etag).toBe('"v1"');
    const second = await connector.fetch({ config: query, cursor: first.cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(http.requests[1]!.etag).toBe('"v1"');
    expect(second).toEqual({ items: [], cursor: first.cursor });
  });

  it("error kinds", async () => {
    const run = (reply: Parameters<FakeHttp["onPrefix"]>[1]) =>
      connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(new FakeHttp().onPrefix("https://hn.algolia.com/", reply)) });
    await expectError(run({ status: 429, text: "slow down" }), "rate_limited");
    await expectError(run({ status: 503, text: "" }), "network");
    await expectError(run({ status: 404, text: "" }), "not_found");
    await expectError(run({ status: 400, text: "" }), "bad_response");
    await expectError(run({ text: "<html>not json</html>" }), "bad_response");
    await expectError(run({ json: { message: "no hits" } }), "bad_response");
    await expectError(run({ error: new HttpError("timeout", "slow") }), "network", /did not answer in time/);
    await expectError(run({ error: new HttpError("network", "reset") }), "network");
    await expectError(run({ error: new HttpError("blocked_address", "private") }), "blocked");
    await expectError(run({ error: new HttpError("too_large", "big") }), "bad_response");
  });

  it("odd hits are skipped", async () => {
    const http = new FakeHttp().onPrefix("https://hn.algolia.com/", {
      json: {
        hits: [
          null,
          { objectID: "x1", title: "No numeric id", points: 100, num_comments: 1, created_at_i: NOW / 1000 - 10 },
          { objectID: "123", title: "", points: 100, num_comments: 1, created_at_i: NOW / 1000 - 10 },
          { objectID: 124, title: "Number id", points: 100, num_comments: 1, created_at_i: NOW / 1000 - 10, url: "javascript:alert(1)" },
        ],
      },
    });
    const result = await connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.externalId)).toEqual(["124"]);
    expect(result.items[0]!.url).toBe("https://news.ycombinator.com/item?id=124");
  });
});

// ---------------------------------------------------------------------------
// fetch: Reddit
// ---------------------------------------------------------------------------

describe("community fetch: reddit", () => {
  const config = cfg({ variant: "reddit", subreddit: "LocalLLaMA" });
  beforeEach(() => clearRedditTokensForTests());
  afterEach(() => clearRedditTokensForTests());

  it("no credentials: the public .json listing; 403 and 429 are `blocked` with the stated message", async () => {
    for (const status of [403, 429]) {
      const http = new FakeHttp().onPrefix("https://www.reddit.com/", { status, text: reddit403, headers: { "content-type": "text/html" } });
      await expectError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }), "blocked", REDDIT_BLOCKED_MESSAGE);
      expect(http.urls[0]).toBe("https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=30&raw_json=1");
    }
  });

  it("no credentials: an HTML page with status 200 is `blocked` too", async () => {
    const http = new FakeHttp().onPrefix("https://www.reddit.com/", { text: reddit403 });
    await expectError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }), "blocked", REDDIT_BLOCKED_MESSAGE);
  });

  it("the listing: minScore in code, link and self posts, removed text, deleted author", async () => {
    const http = new FakeHttp().on("https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=30&raw_json=1", { text: redditTop });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.externalId)).toEqual(["1q0z001", "1q0z002", "1q0z004"]);
    const [link, self, removed] = result.items;
    expect(link).toMatchObject({
      url: "https://example.com/blog/new-coding-model",
      author: "example_user_a",
      publishedAt: 1_795_089_600_000,
      kind: "discussion",
      meta: { score: 812, comments: 214, flair: "New Model" },
    });
    expect(link!.links).toEqual([
      "https://example.com/blog/new-coding-model",
      "https://www.reddit.com/r/LocalLLaMA/comments/1q0z001/new_openweights_coding_model",
    ]);
    expect(self!.url).toBe("https://www.reddit.com/r/LocalLLaMA/comments/1q0z002/how_we_run_evals/");
    expect(self!.text).toContain("We run 300 tasks each night.");
    expect(self!.links).toContain("https://github.com/example/agent-evals");
    expect(removed!.text).toBe("Benchmark thread: local inference on a laptop");
    expect(removed!.author).toBeUndefined();
    expect(result.cursor).toEqual({ variant: "reddit", seenIds: ["1q0z001", "1q0z002", "1q0z004"] });
  });

  it("listing paths and a later poll", async () => {
    const http = new FakeHttp().onPrefix("https://www.reddit.com/", { text: redditTop });
    const hot = cfg({ variant: "reddit", subreddit: "LocalLLaMA", listing: "new", minScore: 0 });
    const result = await connector.fetch({
      config: hot,
      cursor: { variant: "reddit", seenIds: ["1q0z001", "1q0z002"] },
      mode: "poll",
      limit: 30,
      ctx: ctxWith(http),
    });
    expect(http.urls[0]).toBe("https://www.reddit.com/r/LocalLLaMA/new.json?limit=30&raw_json=1");
    expect(result.items.map((i) => i.externalId)).toEqual(["1q0z003", "1q0z004"]);
  });

  it("an unknown subreddit is not_found", async () => {
    const http = new FakeHttp().onPrefix("https://www.reddit.com/", { status: 404, json: { message: "Not Found", error: 404 } });
    await expectError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }), "not_found", /r\/LocalLLaMA/);
  });

  describe("with REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET", () => {
    const env = makeEnv({ REDDIT_CLIENT_ID: "client-id", REDDIT_CLIENT_SECRET: "client-secret" });

    it("takes the client-credentials token once and reads oauth.reddit.com", async () => {
      const http = new FakeHttp()
        .on("https://www.reddit.com/api/v1/access_token", { text: redditToken })
        .onPrefix("https://oauth.reddit.com/", { text: redditTop });
      const ctx = ctxWith(http, { env });
      const first = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });
      expect(first.items).toHaveLength(3);
      await connector.fetch({ config, cursor: first.cursor, mode: "poll", limit: 30, ctx });

      expect(http.count("https://www.reddit.com/api/v1/access_token")).toBe(1);
      const tokenReq = http.requests[0] as HttpRequest;
      expect(tokenReq.method).toBe("POST");
      expect(tokenReq.body).toBe("grant_type=client_credentials");
      expect(tokenReq.headers?.Authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
      expect(http.urls[1]).toBe("https://oauth.reddit.com/r/LocalLLaMA/top?t=day&limit=30&raw_json=1");
      expect(http.requests[1]!.headers?.Authorization).toBe("Bearer synthetic-test-token");
      expect(http.count(/^https:\/\/www\.reddit\.com\/r\//)).toBe(0);
    });

    it("a 401 on the listing takes a new token once", async () => {
      let calls = 0;
      const http = new FakeHttp()
        .on("https://www.reddit.com/api/v1/access_token", { text: redditToken })
        .onPrefix("https://oauth.reddit.com/", () => (++calls === 1 ? { status: 401, text: "" } : { text: redditTop }));
      const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http, { env }) });
      expect(result.items).toHaveLength(3);
      expect(http.count("https://www.reddit.com/api/v1/access_token")).toBe(2);
    });

    it("refused credentials are needs_credentials; a private subreddit is blocked; 429 is rate_limited", async () => {
      const refused = new FakeHttp().on("https://www.reddit.com/api/v1/access_token", { status: 401, json: { error: 401 } });
      await expectError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(refused, { env }) }), "needs_credentials");

      clearRedditTokensForTests();
      const priv = new FakeHttp()
        .on("https://www.reddit.com/api/v1/access_token", { text: redditToken })
        .onPrefix("https://oauth.reddit.com/", { status: 403, json: { reason: "private", message: "Forbidden" } });
      await expectError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(priv, { env }) }), "blocked", /private/);

      const slow = new FakeHttp()
        .on("https://www.reddit.com/api/v1/access_token", { text: redditToken })
        .onPrefix("https://oauth.reddit.com/", { status: 429, text: "" });
      await expectError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(slow, { env }) }), "rate_limited");
    });
  });
});

// ---------------------------------------------------------------------------
// fetch: Discourse
// ---------------------------------------------------------------------------

describe("community fetch: discourse", () => {
  const latest = cfg({ variant: "discourse", baseUrl: "https://discuss.huggingface.co" });

  it("first poll: latest.json?order=created, newest first, the first post of the newest topics", async () => {
    const http = new FakeHttp()
      .on("https://discuss.huggingface.co/latest.json?order=created", { text: hfLatest })
      .on("https://discuss.huggingface.co/t/192205.json", { text: hfTopic })
      .onPrefix("https://discuss.huggingface.co/t/", { status: 404, text: "" });
    const result = await connector.fetch({ config: latest, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(10);
    const first = result.items[0]!;
    expect(first).toMatchObject({
      externalId: "192205",
      url: "https://discuss.huggingface.co/t/we-let-an-ai-agent-edit-a-tesseract-models-weights-directly-it-beat-a-last-layer-refit-not-fine-tuning/192205",
      author: "user128273",
      kind: "discussion",
      publishedAt: Date.parse("2026-11-20T09:45:31.107Z"),
    });
    expect(first.text).toContain("Tesseract");
    expect(first.text).not.toMatch(/<p>/);
    expect(first.meta).toMatchObject({ site: "discourse", forum: "discuss.huggingface.co", replies: 0 });
    // A failed first-post request keeps the title as the text.
    expect(result.items[1]!.text).toBe(result.items[1]!.title);
    // At most 8 first-post requests.
    expect(http.count(/\/t\/\d+\.json$/)).toBe(8);
    expect(result.cursor!.seenIds).toHaveLength(10);
  });

  it("a category: the slug path and the id; preview reads at most 3 first posts", async () => {
    const config = cfg({ variant: "discourse", baseUrl: "https://community.openai.com", categorySlug: "codex/codex-cli", categoryId: 39 });
    const http = new FakeHttp()
      .on("https://community.openai.com/c/codex/codex-cli/39.json?order=created", { text: openaiCategory })
      .onPrefix("https://community.openai.com/t/", { json: { post_stream: { posts: [{ post_number: 1, cooked: "<p>Body text</p>" }] } } });
    const result = await connector.fetch({ config, cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http) });
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(6);
    expect(result.items[0]!.externalId).toBe("1417548");
    expect(result.items[0]!.text).toContain("Body text");
    expect(http.count(/\/t\/\d+\.json$/)).toBe(3);
  });

  it("a tag inside a category keeps the topics of the category", async () => {
    const config = cfg({ variant: "discourse", baseUrl: "https://community.openai.com", tag: "codex", categoryId: 7 });
    const http = new FakeHttp().on("https://community.openai.com/tag/codex.json?order=created", { text: openaiCategory });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toEqual([]);
  });

  it("a later poll returns only new topics", async () => {
    const http = new FakeHttp().onPrefix("https://discuss.huggingface.co/", (req) =>
      req.url.includes("latest.json") ? { text: hfLatest } : { status: 404, text: "" },
    );
    const first = await connector.fetch({ config: latest, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    const cursor: CommunityCursor = { ...first.cursor!, seenIds: first.cursor!.seenIds.slice(2) };
    const second = await connector.fetch({ config: latest, cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(second.items.map((i) => i.externalId)).toEqual(["192205", "192204"]);
  });

  it("error kinds", async () => {
    const run = (reply: Parameters<FakeHttp["onPrefix"]>[1]) =>
      connector.fetch({ config: latest, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(new FakeHttp().onPrefix("https://discuss.huggingface.co/", reply)) });
    await expectError(run({ status: 403, text: "" }), "blocked", /needs a login/);
    await expectError(run({ status: 404, json: { errors: ["not found"] } }), "not_found");
    await expectError(run({ status: 429, text: "" }), "rate_limited");
    await expectError(run({ text: "<html>a blog</html>" }), "bad_response", /Discourse/);
    await expectError(run({ json: { latest: [] } }), "bad_response");
  });
});
