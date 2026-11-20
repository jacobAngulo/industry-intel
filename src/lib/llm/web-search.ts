// The web search of the Ollama cloud API (specification §11.3 and §20).
// POST {OLLAMA_HOST}/api/web_search with { query, max_results } ->
// { results: [{ title, url, content }] }. The Content-Type can be text/html
// with a JSON body, so the text is parsed as JSON by hand.
import { z } from "zod";

import type { UsageMeter } from "@/lib/connectors/types";
import type { Env } from "@/lib/env";
import type { SafeHttp } from "@/lib/http/types";

import { errorBodyText, errorForStatus, errorForThrown, safeText } from "./errors";
import { LlmError, type WebSearchProvider, type WebSearchResult } from "./types";

export const WEB_SEARCH_TIMEOUT_MS = 30_000;
export const WEB_SEARCH_MAX_BYTES = 6_000_000;
/** `content` can be longer than 100 000 characters: it is cut to this length. */
export const WEB_SEARCH_CONTENT_MAX = 2000;
export const WEB_SEARCH_TITLE_MAX = 300;
export const WEB_SEARCH_QUERY_MAX = 400;

const WHAT = "The web search";

export interface WebSearchDeps {
  http: SafeHttp;
  usage: UsageMeter;
  env: Env;
}

const resultSchema = z.object({
  title: z.string().catch(""),
  url: z.string().catch(""),
  content: z.string().catch(""),
});
const bodySchema = z.object({ results: z.array(z.unknown()).catch([]) });

function httpUrl(value: string): string | null {
  const text = value.trim();
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? text : null;
  } catch {
    return null;
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export class OllamaWebSearch implements WebSearchProvider {
  readonly #deps: WebSearchDeps;

  constructor(deps: WebSearchDeps) {
    this.#deps = deps;
  }

  async search(q: { query: string; maxResults: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const { http, usage, env } = this.#deps;
    const key = env.ollamaApiKey;
    if (key === undefined) throw new LlmError("no_key", "The model key is missing, so the web search is not available.");
    const query = cut(q.query.replace(/\s+/g, " ").trim(), WEB_SEARCH_QUERY_MAX);
    if (query === "") return [];
    if (q.signal?.aborted) throw new LlmError("timeout", "The web search was stopped before it started.");
    const maxResults = Math.min(10, Math.max(1, Math.round(Number.isFinite(q.maxResults) ? q.maxResults : 5)));

    if (!usage.take("web_searches", 1)) {
      throw new LlmError("budget", "The web search limit for today is used.");
    }

    let res;
    try {
      res = await http.request({
        url: `${env.ollamaHost}/api/web_search`,
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, max_results: maxResults }),
        timeoutMs: WEB_SEARCH_TIMEOUT_MS,
        maxBytes: WEB_SEARCH_MAX_BYTES,
        ...(q.signal ? { signal: q.signal } : {}),
      });
    } catch (error) {
      throw errorForThrown(error, WHAT, key);
    }
    if (!res.ok) throw errorForStatus({ status: res.status, body: res.text, headers: res.headers, what: WHAT, key });

    let raw: unknown;
    try {
      raw = JSON.parse(res.text);
    } catch {
      throw new LlmError("overloaded", `${WHAT} sent an answer that is not JSON (HTTP ${res.status}).`);
    }
    if (raw && typeof raw === "object" && "error" in raw && (raw as { error: unknown }).error) {
      throw new LlmError("overloaded", `${WHAT} reported an error: ${safeText(errorBodyText(res.text), key)}`);
    }
    const body = bodySchema.safeParse(raw);
    if (!body.success) throw new LlmError("overloaded", `${WHAT} sent an answer of an unknown shape.`);

    const results: WebSearchResult[] = [];
    for (const entry of body.data.results) {
      const parsed = resultSchema.safeParse(entry);
      if (!parsed.success) continue;
      const url = httpUrl(parsed.data.url);
      if (url === null) continue;
      results.push({
        title: cut(parsed.data.title.replace(/\s+/g, " ").trim(), WEB_SEARCH_TITLE_MAX),
        url,
        content: cut(parsed.data.content, WEB_SEARCH_CONTENT_MAX),
      });
      if (results.length >= maxResults) break;
    }
    return results;
  }
}
