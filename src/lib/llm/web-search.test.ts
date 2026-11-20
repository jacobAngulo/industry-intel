import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { FakeHttp, FakeUsageMeter, loadFixture, makeEnv, type FakeHttpReply } from "@/test/helpers";

import { getWebSearch } from "./index";
import { WEB_SEARCH_CONTENT_MAX, WEB_SEARCH_MAX_BYTES } from "./web-search";

const KEY = "test-key-not-real-0002";
const URL_SEARCH = "https://ollama.com/api/web_search";
const recorded = loadFixture("web-search.trimmed.json");

function setup(reply: FakeHttpReply, limits: ConstructorParameters<typeof FakeUsageMeter>[0] = {}) {
  const http = new FakeHttp().on(URL_SEARCH, reply);
  const usage = new FakeUsageMeter(limits);
  const search = getWebSearch({ http, usage, env: makeEnv({ OLLAMA_API_KEY: KEY }) });
  if (!search) throw new Error("expected a web search provider");
  return { http, usage, search };
}

describe("getWebSearch", () => {
  it("is null with no key", () => {
    expect(getWebSearch({ http: new FakeHttp(), usage: new FakeUsageMeter(), env: makeEnv() })).toBeNull();
  });

  it("returns the results of a recorded reply (text/html content type) and takes one web_searches unit", async () => {
    const t = setup({ text: recorded, headers: { "content-type": "text/html; charset=utf-8" } });
    const results = await t.search.search({ query: "  Model Context Protocol   specification update ", maxResults: 3 });

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ title: "Key Changes", url: "https://modelcontextprotocol.io/specification/2026-07-28/changelog" });
    expect(results[0]?.content).toContain("Key Changes");
    expect(t.usage.today("web_searches")).toBe(1);

    const [req] = t.http.requests;
    expect(req).toMatchObject({ method: "POST", maxBytes: WEB_SEARCH_MAX_BYTES });
    expect(req?.headers?.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ query: "Model Context Protocol specification update", max_results: 3 });
  });

  it("cuts a content of 100 000 characters to 2000", async () => {
    const big = "x".repeat(100_000);
    const t = setup({ json: { results: [{ title: "Big page", url: "https://example.com/big", content: big }] } });
    const [result] = await t.search.search({ query: "big", maxResults: 5 });
    expect(result?.content).toHaveLength(WEB_SEARCH_CONTENT_MAX);
  });

  it("drops results with no http(s) URL and fills missing fields", async () => {
    const t = setup({
      json: {
        results: [
          { title: "ok", url: "https://example.com/a", content: "a" },
          { title: "script", url: "javascript:alert(1)", content: "b" },
          { title: "ftp", url: "ftp://example.com/c", content: "c" },
          { title: "relative", url: "/d", content: "d" },
          { title: "none", content: "e" },
          "not an object",
          { url: "http://example.com/f" },
        ],
      },
    });
    const results = await t.search.search({ query: "q", maxResults: 10 });
    expect(results).toEqual([
      { title: "ok", url: "https://example.com/a", content: "a" },
      { title: "", url: "http://example.com/f", content: "" },
    ]);
  });

  it("clamps max_results to 1..10 and returns at most that many", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `r${i}`, url: `https://example.com/${i}`, content: "" }));
    const t = setup({ json: { results: many } });
    expect(await t.search.search({ query: "q", maxResults: 50 })).toHaveLength(10);
    expect(await t.search.search({ query: "q", maxResults: 0 })).toHaveLength(1);
    expect(t.http.requests.map((req) => JSON.parse(req.body ?? "{}").max_results)).toEqual([10, 1]);
  });

  it("stops at the daily limit with kind budget and no HTTP call", async () => {
    const t = setup({ text: recorded }, { web_searches: 1 });
    await t.search.search({ query: "first", maxResults: 3 });
    await expect(t.search.search({ query: "second", maxResults: 3 })).rejects.toMatchObject({ name: "LlmError", kind: "budget" });
    expect(t.http.requests).toHaveLength(1);
  });

  it("makes no call and takes no unit for an empty query", async () => {
    const t = setup({ text: recorded });
    expect(await t.search.search({ query: "   ", maxResults: 3 })).toEqual([]);
    expect(t.http.requests).toHaveLength(0);
    expect(t.usage.today("web_searches")).toBe(0);
  });

  it("maps the errors", async () => {
    const wrongKey = setup({ status: 401, text: loadFixture("error-401-wrong-key.web-search.json") });
    const error = await wrongKey.search.search({ query: "q", maxResults: 3 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "auth" });
    expect((error as Error).message).not.toContain(KEY);

    await expect(setup({ status: 429, text: "", headers: { "retry-after": "5" } }).search.search({ query: "q", maxResults: 3 })).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 5000,
    });
    await expect(setup({ status: 502, text: "" }).search.search({ query: "q", maxResults: 3 })).rejects.toMatchObject({ kind: "overloaded" });
    await expect(setup({ text: "<html>not json</html>" }).search.search({ query: "q", maxResults: 3 })).rejects.toMatchObject({ kind: "overloaded" });
    await expect(setup({ json: { error: "busy" } }).search.search({ query: "q", maxResults: 3 })).rejects.toMatchObject({ kind: "overloaded" });
    await expect(setup({ error: new HttpError("timeout", "slow") }).search.search({ query: "q", maxResults: 3 })).rejects.toMatchObject({ kind: "timeout" });
    await expect(setup({ error: new HttpError("network", "reset") }).search.search({ query: "q", maxResults: 3 })).rejects.toMatchObject({ kind: "network" });
  });
});
