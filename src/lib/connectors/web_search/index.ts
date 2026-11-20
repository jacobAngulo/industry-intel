// The `web_search` connector (specification §6.3): a saved web search
// through ctx.search (the web search API of Ollama, same key as the model).
// The first successful run is a baseline; later runs emit only the URLs that
// the source did not return before. Results have no date.
//
// The provider takes one `web_searches` for each search: this connector does
// not count.
import { LlmError } from "@/lib/llm/types";
import { canonicalizeUrl, extractLinks, htmlToText, sha, stripInvisible, truncate } from "@/lib/text";
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, sourceKey, webSearchConfigSchema, type WebSearchConfig } from "../configs";
import {
  ConnectorError,
  RAW_ITEM_MAX_LINKS,
  RAW_ITEM_MAX_TEXT,
  type Candidate,
  type Connector,
  type ConnectorContext,
  type RawItem,
} from "../types";

import { buildWebQuery, domainAllowed, hostOf, splitSiteTerms } from "./domains";

export { buildWebQuery, domainAllowed, hostMatches, splitSiteTerms } from "./domains";

/** The cursor of a web_search source (sources.cursor). */
export interface WebSearchCursor {
  /** Canonical URLs that the source returned before, oldest first (at most 1000). */
  seenUrls: string[];
}

export const WEB_SEARCH_MAX_SEEN_URLS = 1000;

/** The note for the preview step of the wizard (PreviewResult.entries[].note). */
export const WEB_SEARCH_PREVIEW_NOTE =
  "These are the current results. The first check stores them as a baseline and does not judge them; later checks show only new results.";

const NEEDS_KEY_MESSAGE = "Needs the model key. The web search uses OLLAMA_API_KEY: add it to the .env file and start the app again.";

function looksLikeUrlOrAddress(entry: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry) ||
    /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(entry)
  );
}

/** The config and confidence for one entry, or null. Pattern checks only. */
export function parseSearchEntry(
  input: string,
  forced: boolean,
): { query: string; allowedDomains: string[]; excludedDomains: string[]; confidence: number } | null {
  let entry = input.trim();
  if (entry === "" || /[\r\n]/.test(entry)) return null;

  let confidence = forced ? 0.9 : 0.3;
  const hint = /^(?:web|search|web search)\s*:\s*(.+)$/i.exec(entry);
  if (hint) {
    entry = hint[1]!.trim();
    confidence = Math.max(confidence, 0.85);
  } else {
    if (looksLikeUrlOrAddress(entry)) return null;
    // A single @handle is an X user.
    if (/^@\w+$/.test(entry) && !forced) return null;
  }

  const split = splitSiteTerms(entry);
  if (split.query.length < 2) return null;
  if (split.allowed.length > 0 || split.excluded.length > 0) confidence = Math.max(confidence, 0.7);
  return { query: split.query, allowedDomains: split.allowed, excludedDomains: split.excluded, confidence };
}

function describe(config: WebSearchConfig): string {
  const parts = [`Web search for "${truncate(config.query, 80)}"`];
  if (config.allowedDomains.length > 0) parts.push(`only ${config.allowedDomains.slice(0, 3).join(", ")}${config.allowedDomains.length > 3 ? ", …" : ""}`);
  if (config.excludedDomains.length > 0) parts.push(`not ${config.excludedDomains.slice(0, 3).join(", ")}${config.excludedDomains.length > 3 ? ", …" : ""}`);
  return `${parts.join("; ")}. New results only; the first check is a baseline.`;
}

function candidateFor(entry: NonNullable<ReturnType<typeof parseSearchEntry>>, ctx: ConnectorContext): Candidate[] {
  const parsed = webSearchConfigSchema.safeParse({
    query: entry.query,
    allowedDomains: entry.allowedDomains,
    excludedDomains: entry.excludedDomains,
  });
  if (!parsed.success) return [];
  const warnings: string[] = [];
  if (!ctx.env.has("OLLAMA_API_KEY")) warnings.push("Needs the model key (OLLAMA_API_KEY): the web search uses the same key.");
  return [
    {
      type: "web_search",
      name: truncate(`Web: ${parsed.data.query}`, 120),
      description: describe(parsed.data),
      config: parsed.data,
      confidence: entry.confidence,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  ];
}

/** Maps an error of the search provider to a ConnectorError. */
export function mapSearchError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof LlmError) {
    switch (error.kind) {
      case "no_key":
      case "auth":
        return new ConnectorError("needs_credentials", "The web search refused the model key. Check OLLAMA_API_KEY in the .env file.", { cause: error });
      case "budget":
        return new ConnectorError("budget", "The daily limit of web searches is used (WEB_SEARCH_MAX_PER_DAY). The next check runs after midnight (UTC).", { cause: error });
      case "payment":
        // No credits is an account problem, not the daily limit: it counts as a failure.
        return new ConnectorError("blocked", "The Ollama account has no credits left for the web search.", { cause: error });
      case "rate_limited":
        return new ConnectorError("rate_limited", "The web search rate limit is reached. The next check tries again.", { cause: error });
      case "network":
      case "timeout":
      case "overloaded":
        return new ConnectorError("network", "The web search is not available now. The next check tries again.", { cause: error });
      default:
        return new ConnectorError("bad_response", "The web search returned a response that the app cannot read.", { cause: error });
    }
  }
  return new ConnectorError("bad_response", "The web search failed. The next check tries again.", { cause: error });
}

function plainText(content: string): string {
  const raw = typeof content === "string" ? content : "";
  const text = /<\/?(p|div|span|a|br|li|ul|h[1-6]|html|body)\b[^>]*>/i.test(raw) ? htmlToText(raw) : raw;
  return truncate(stripInvisible(text).trim(), RAW_ITEM_MAX_TEXT);
}

/** The current results as items: filtered by the domain lists, one item for each canonical URL, in search order. */
export function resultsToItems(
  results: Array<{ title: string; url: string; content: string }>,
  config: WebSearchConfig,
): Array<RawItem & { url: string }> {
  const seen = new Set<string>();
  const items: Array<RawItem & { url: string }> = [];
  results.forEach((result, index) => {
    const url = typeof result.url === "string" ? result.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || !domainAllowed(url, config.allowedDomains, config.excludedDomains)) return;
    const canonical = canonicalizeUrl(url);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const text = plainText(result.content);
    const title = truncate(stripInvisible(String(result.title ?? "")).replace(/\s+/g, " ").trim(), 300) || hostOf(url) || canonical;
    items.push({
      externalId: sha(canonical),
      url: canonical,
      title,
      kind: "search_result",
      text,
      links: extractLinks(typeof result.content === "string" ? result.content : "", canonical)
        .filter((link) => link !== canonical)
        .slice(0, RAW_ITEM_MAX_LINKS),
      meta: { undated: true, rank: index + 1, query: config.query },
    });
  });
  return items;
}

/** The new seen list: the old one with the current URLs moved to the end (newest), at most 1000. */
export function mergeSeen(previous: string[], current: string[]): string[] {
  const now = new Set(current);
  const merged = [...previous.filter((url) => !now.has(url)), ...current];
  return merged.slice(Math.max(0, merged.length - WEB_SEARCH_MAX_SEEN_URLS));
}

export const connector: Connector<WebSearchConfig, WebSearchCursor> = {
  type: "web_search",
  label: SOURCE_TYPE_LABELS.web_search,
  description: "A saved web search: new results for a query, with allowed and excluded domains.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.web_search.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.web_search.maxAgeDays,
  configSchema: webSearchConfigSchema,
  needs: (env, config) => credentialNeeds("web_search", env, config),
  keyOf: (config) => sourceKey("web_search", config),

  async resolve(input, ctx, forced) {
    const entry = parseSearchEntry(input, forced);
    return entry ? candidateFor(entry, ctx) : [];
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const parsedConfig = webSearchConfigSchema.parse(config);
    if (!ctx.search) throw new ConnectorError("needs_credentials", NEEDS_KEY_MESSAGE);

    let results: Array<{ title: string; url: string; content: string }>;
    try {
      results = await ctx.search.search({
        query: buildWebQuery(parsedConfig.query, parsedConfig.allowedDomains),
        maxResults: parsedConfig.maxResults,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      throw mapSearchError(error);
    }
    if (!Array.isArray(results)) throw new ConnectorError("bad_response", "The web search returned a response that the app cannot read.");

    const current = resultsToItems(results, parsedConfig);
    const max = Math.max(0, limit);

    if (mode === "preview") return { items: current.slice(0, max), cursor: null };

    const previous = cursor && Array.isArray(cursor.seenUrls) ? cursor.seenUrls.filter((u) => typeof u === "string") : null;
    const nextCursor: WebSearchCursor = { seenUrls: mergeSeen(previous ?? [], current.map((item) => item.url)) };

    if (previous === null) {
      // The first successful run: store everything, judge nothing.
      return { items: current.slice(0, max).map((item) => ({ ...item, skip: "baseline" as const })), cursor: nextCursor };
    }
    const known = new Set(previous);
    return { items: current.filter((item) => !known.has(item.url)).slice(0, max), cursor: nextCursor };
  },
};
