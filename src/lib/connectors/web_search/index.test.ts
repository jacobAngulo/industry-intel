import { describe, expect, it } from "vitest";

import { LlmError, type WebSearchProvider, type WebSearchResult } from "@/lib/llm/types";
import { canonicalizeUrl, sha } from "@/lib/text";
import { loadFixture, makeConnectorContext, makeEnv } from "@/test/helpers";

import { webSearchConfigSchema } from "../configs";
import { ConnectorError, type ConnectorContext } from "../types";

import {
  WEB_SEARCH_MAX_SEEN_URLS,
  WEB_SEARCH_PREVIEW_NOTE,
  buildWebQuery,
  connector,
  domainAllowed,
  hostMatches,
  mapSearchError,
  mergeSeen,
  parseSearchEntry,
  splitSiteTerms,
  type WebSearchCursor,
} from "./index";

/** A WebSearchProvider with scripted results and a call log. */
class FakeSearch implements WebSearchProvider {
  readonly calls: Array<{ query: string; maxResults: number; signal?: AbortSignal }> = [];
  constructor(private readonly reply: WebSearchResult[] | (() => Promise<WebSearchResult[]>)) {}
  async search(q: { query: string; maxResults: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    this.calls.push(q);
    return typeof this.reply === "function" ? this.reply() : this.reply;
  }
}

const recorded = (JSON.parse(loadFixture("web-search.recorded.json")) as { results: WebSearchResult[] }).results;

function setup(reply: WebSearchResult[] | (() => Promise<WebSearchResult[]>) = recorded, key = true) {
  const search = new FakeSearch(reply);
  const ctx = makeConnectorContext({ search, env: makeEnv(key ? { OLLAMA_API_KEY: "test-key" } : {}) });
  return { search, ctx };
}

const config = webSearchConfigSchema.parse({ query: "MCP specification changes" });

async function fetchError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }
  throw new Error("expected a ConnectorError");
}

describe("web_search resolve", () => {
  const { ctx, search } = setup();

  it("is a low-confidence candidate for topic text and makes no search", async () => {
    const [candidate] = await connector.resolve("agent evaluation harness", ctx, false);
    expect(candidate).toMatchObject({ type: "web_search", name: "Web: agent evaluation harness", confidence: 0.3 });
    expect(candidate!.config).toEqual({ query: "agent evaluation harness", allowedDomains: [], excludedDomains: [], maxResults: 8 });
    expect(candidate!.description).toContain("the first check is a baseline");
    expect(candidate!.warnings).toBeUndefined();
    expect(search.calls).toHaveLength(0);
  });

  it("is sure when forced or with a hint, and reads site: terms", async () => {
    expect((await connector.resolve("agent evals", ctx, true))[0]!.confidence).toBe(0.9);
    expect((await connector.resolve("web: agent evals", ctx, false))[0]!.confidence).toBe(0.85);
    const [candidate] = await connector.resolve("agent evals site:openai.com site:www.anthropic.com -site:reddit.com", ctx, false);
    expect(candidate!.config).toEqual({
      query: "agent evals",
      allowedDomains: ["openai.com", "anthropic.com"],
      excludedDomains: ["reddit.com"],
      maxResults: 8,
    });
    expect(candidate!.confidence).toBe(0.7);
    expect(candidate!.description).toContain("only openai.com, anthropic.com; not reddit.com");
  });

  it.each(["", "x", "https://example.com/page", "example.com", "news@example.com", "@chamath", "two\nlines", "site:example.com"])(
    "returns no candidate for %j",
    async (input) => {
      expect(await connector.resolve(input, ctx, false)).toEqual([]);
    },
  );

  it("warns when the model key is missing", async () => {
    const noKey = setup(recorded, false);
    expect((await connector.resolve("agent evals", noKey.ctx, false))[0]!.warnings).toEqual([
      "Needs the model key (OLLAMA_API_KEY): the web search uses the same key.",
    ]);
  });

  it("rejects a bad domain in a site: term", () => {
    expect(parseSearchEntry("evals site:not_a_domain", false)).not.toBeNull();
    return connector.resolve("evals site:not_a_domain", ctx, false).then((found) => expect(found).toEqual([]));
  });
});

describe("web_search needs and key", () => {
  it("needs the model key and keys on query and allowed domains", () => {
    expect(connector.needs(makeEnv({}), config)?.code).toBe("model_key");
    expect(connector.needs(makeEnv({ OLLAMA_API_KEY: "k" }), config)).toBeNull();
    expect(connector.keyOf(webSearchConfigSchema.parse({ query: "Q", allowedDomains: ["b.com", "a.com"] }))).toBe("web_search:q|a.com,b.com");
  });
});

describe("web_search fetch", () => {
  it("first poll: a baseline of every result", async () => {
    const { ctx, search } = setup();
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });
    expect(search.calls).toEqual([{ query: "MCP specification changes", maxResults: 8 }]);
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.skip).toBe("baseline");
      expect(item.kind).toBe("search_result");
      expect(item.publishedAt).toBeUndefined();
      expect(item.meta).toMatchObject({ undated: true });
      expect(item.externalId).toBe(sha(canonicalizeUrl(item.url!)));
    }
    expect(result.items[0]).toMatchObject({
      title: "Key Changes",
      url: "https://modelcontextprotocol.io/specification/2026-07-28/changelog",
      meta: { rank: 1, query: "MCP specification changes" },
    });
    expect(result.items[0]!.text).toContain("This document lists changes");
    expect(result.items[0]!.links).toEqual(["https://modelcontextprotocol.io/llms.txt"]);
    expect(result.cursor).toEqual({
      seenUrls: [
        "https://modelcontextprotocol.io/specification/2026-07-28/changelog",
        "https://blog.modelcontextprotocol.io/posts/2026-07-28",
        "https://blog.modelcontextprotocol.io/posts/mcp-release-cycle",
      ],
    });
  });

  it("later poll: only URLs that the source did not return before", async () => {
    const results: WebSearchResult[] = [
      { title: "Old one", url: "https://blog.modelcontextprotocol.io/posts/2026-07-28/?utm_source=x", content: "known" },
      { title: "New one", url: "https://example.org/new-post#top", content: "<p>Fresh <a href=\"https://example.org/more\">more</a></p>" },
    ];
    const { ctx } = setup(results);
    const cursor: WebSearchCursor = { seenUrls: ["https://blog.modelcontextprotocol.io/posts/2026-07-28", "https://example.org/older"] };
    const result = await connector.fetch({ config, cursor, mode: "poll", limit: 30, ctx });
    expect(result.items.map((item) => item.url)).toEqual(["https://example.org/new-post"]);
    expect(result.items[0]!.skip).toBeUndefined();
    expect(result.items[0]!.text).toBe("Fresh more");
    expect(result.items[0]!.links).toEqual(["https://example.org/more"]);
    // The seen URLs move to the end; the order is oldest first.
    expect(result.cursor).toEqual({
      seenUrls: ["https://example.org/older", "https://blog.modelcontextprotocol.io/posts/2026-07-28", "https://example.org/new-post"],
    });
  });

  it("a later poll with no new URL returns nothing (like not-modified)", async () => {
    const { ctx } = setup();
    const first = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });
    const second = await connector.fetch({ config, cursor: first.cursor, mode: "poll", limit: 30, ctx });
    expect(second.items).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("a baseline with no result still ends the baseline", async () => {
    const { ctx } = setup([]);
    const first = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx });
    expect(first).toEqual({ items: [], cursor: { seenUrls: [] } });
    const later = setup([{ title: "A", url: "https://a.example.com/x", content: "a" }]);
    const second = await connector.fetch({ config, cursor: first.cursor, mode: "poll", limit: 30, ctx: later.ctx });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.skip).toBeUndefined();
  });

  it("keeps at most 1000 seen URLs and drops the oldest", async () => {
    const seen = Array.from({ length: WEB_SEARCH_MAX_SEEN_URLS }, (_, i) => `https://example.com/p${i}`);
    const { ctx } = setup([{ title: "N", url: "https://example.com/new", content: "" }]);
    const result = await connector.fetch({ config, cursor: { seenUrls: seen }, mode: "poll", limit: 30, ctx });
    expect(result.cursor!.seenUrls).toHaveLength(WEB_SEARCH_MAX_SEEN_URLS);
    expect(result.cursor!.seenUrls[0]).toBe("https://example.com/p1");
    expect(result.cursor!.seenUrls.at(-1)).toBe("https://example.com/new");
  });

  it("applies allowed and excluded domains in code, with subdomains, and site: terms for up to 3 domains", async () => {
    const results: WebSearchResult[] = [
      { title: "1", url: "https://docs.openai.com/a", content: "" },
      { title: "2", url: "https://openai.com.evil.example/b", content: "" },
      { title: "3", url: "https://community.openai.com/c", content: "" },
      { title: "4", url: "https://anthropic.com/d", content: "" },
      { title: "5", url: "ftp://openai.com/e", content: "" },
      { title: "6", url: "https://notopenai.com/f", content: "" },
    ];
    const { ctx, search } = setup(results);
    const cfg = webSearchConfigSchema.parse({
      query: "agents",
      allowedDomains: ["openai.com", "anthropic.com"],
      excludedDomains: ["community.openai.com"],
      maxResults: 10,
    });
    const result = await connector.fetch({ config: cfg, cursor: { seenUrls: [] }, mode: "poll", limit: 30, ctx });
    expect(search.calls[0]).toEqual({ query: "agents site:openai.com OR site:anthropic.com", maxResults: 10 });
    expect(result.items.map((item) => item.title)).toEqual(["1", "4"]);
  });

  it("dedupes results with the same canonical URL and names an empty title by its host", async () => {
    const { ctx } = setup([
      { title: "", url: "https://example.com/a/?utm_medium=x", content: "one" },
      { title: "Again", url: "https://EXAMPLE.com/a", content: "two" },
    ]);
    const result = await connector.fetch({ config, cursor: { seenUrls: [] }, mode: "poll", limit: 30, ctx });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe("example.com");
  });

  it("preview: the current results, cut to the limit, with no skip and no cursor", async () => {
    const { ctx } = setup();
    const result = await connector.fetch({ config, cursor: null, mode: "preview", limit: 2, ctx });
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.skip === undefined)).toBe(true);
    expect(WEB_SEARCH_PREVIEW_NOTE).toContain("baseline");
  });

  it("needs the search provider", async () => {
    const ctx: ConnectorContext = makeConnectorContext({ search: null });
    expect((await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }))).kind).toBe("needs_credentials");
  });

  it.each([
    ["no_key", "needs_credentials"],
    ["auth", "needs_credentials"],
    ["budget", "budget"],
    ["payment", "blocked"],
    ["rate_limited", "rate_limited"],
    ["network", "network"],
    ["timeout", "network"],
    ["overloaded", "network"],
    ["bad_output", "bad_response"],
    ["bad_request", "bad_response"],
  ] as const)("maps the provider error %s to %s", async (llmKind, kind) => {
    const { ctx } = setup(() => Promise.reject(new LlmError(llmKind, "provider detail")));
    const error = await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }));
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("provider detail");
  });

  it("maps an unknown failure and a response that is not a list", async () => {
    expect(mapSearchError(new Error("boom")).kind).toBe("bad_response");
    const { ctx } = setup(() => Promise.resolve({} as unknown as WebSearchResult[]));
    expect((await fetchError(connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx }))).kind).toBe("bad_response");
  });

  it("passes the abort signal and caps a long text", async () => {
    const { ctx, search } = setup([{ title: "Long", url: "https://example.com/long", content: "word ".repeat(10_000) }]);
    const controller = new AbortController();
    const result = await connector.fetch({ config, cursor: { seenUrls: [] }, mode: "poll", limit: 30, ctx: { ...ctx, signal: controller.signal } });
    expect(search.calls[0]!.signal).toBe(controller.signal);
    expect(result.items[0]!.text.length).toBeLessThanOrEqual(20_000);
  });
});

describe("web_search domain helpers", () => {
  it("hostMatches takes subdomains only", () => {
    expect(hostMatches("docs.example.com", "example.com")).toBe(true);
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("badexample.com", "example.com")).toBe(false);
    expect(hostMatches("example.com", "")).toBe(false);
  });

  it("domainAllowed: an exclusion wins; no allowed list allows all", () => {
    expect(domainAllowed("https://a.example.com/x", [], [])).toBe(true);
    expect(domainAllowed("https://a.example.com/x", ["example.com"], ["a.example.com"])).toBe(false);
    expect(domainAllowed("not a url", [], [])).toBe(false);
  });

  it("buildWebQuery adds site: terms for 1 to 3 domains only", () => {
    expect(buildWebQuery(" a   b ", [])).toBe("a b");
    expect(buildWebQuery("a", ["x.com"])).toBe("a site:x.com");
    expect(buildWebQuery("a", ["w.com", "x.com", "y.com", "z.com"])).toBe("a");
  });

  it("splitSiteTerms keeps a literal OR when there is no site list", () => {
    expect(splitSiteTerms("claude OR codex")).toEqual({ query: "claude OR codex", allowed: [], excluded: [] });
    expect(splitSiteTerms("evals site:a.com OR site:b.com")).toEqual({ query: "evals", allowed: ["a.com", "b.com"], excluded: [] });
  });

  it("mergeSeen moves known URLs to the end", () => {
    expect(mergeSeen(["a", "b", "c"], ["a", "d"])).toEqual(["b", "c", "a", "d"]);
  });
});
