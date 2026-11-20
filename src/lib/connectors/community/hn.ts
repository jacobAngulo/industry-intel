// Hacker News through the Algolia search API (https://hn.algolia.com/api/v1/).
// Checked live on 2026-11-20: `search_by_date` with tags=story and
// numericFilters (points, num_comments, created_at_i), and `search` with
// tags=front_page, answer 200 with `hits[]` and no ETag / Last-Modified.
import { z } from "zod";

import { extractLinks, htmlToText } from "@/lib/text";
import { SOURCE_TYPE_DEFAULTS } from "@/lib/types";

import type { CommunityConfig } from "../configs";
import { ConnectorError, type Candidate, type ConnectorContext, type FetchResult, type RawItem } from "../types";
import {
  checkStatus,
  itemLinks,
  itemText,
  num,
  parseJson,
  previewCount,
  readCursor,
  selectNew,
  send,
  str,
  type CommunityCursor,
} from "./shared";

export type HnConfig = Extract<CommunityConfig, { variant: "hn" }>;

export const HN_API = "https://hn.algolia.com/api/v1";
const WHAT = "Hacker News search (hn.algolia.com)";

/** The HN thread page of a story id. */
export function hnThreadUrl(id: string): string {
  return `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
}

const hitSchema = z
  .object({
    objectID: z.union([z.string(), z.number()]).transform(String),
    title: z.string().nullish(),
    url: z.string().nullish(),
    author: z.string().nullish(),
    points: z.number().nullish(),
    num_comments: z.number().nullish(),
    created_at_i: z.number().nullish(),
    created_at: z.string().nullish(),
    story_text: z.string().nullish(),
  })
  .passthrough();
const searchSchema = z.object({ hits: z.array(z.unknown()) }).passthrough();

/** The request URL for one poll or preview. `sinceSec` = the oldest creation time to take. */
export function hnSearchUrl(config: HnConfig, hitsPerPage: number, sinceSec: number): string {
  const filters = [`points>=${config.minPoints}`, `num_comments>=${config.minComments}`, `created_at_i>${sinceSec}`].join(",");
  const params = new URLSearchParams();
  if (config.query) {
    params.set("query", config.query);
    params.set("tags", "story");
  } else {
    params.set("tags", "front_page");
  }
  params.set("numericFilters", filters);
  params.set("hitsPerPage", String(hitsPerPage));
  return `${HN_API}/${config.query ? "search_by_date" : "search"}?${params.toString()}`;
}

/** One Algolia hit to a RawItem, or null when it has no id or no title. */
export function hnHitToItem(raw: unknown): RawItem | null {
  const parsed = hitSchema.safeParse(raw);
  if (!parsed.success) return null;
  const hit = parsed.data;
  const title = str(hit.title);
  if (!title || !/^\d+$/.test(hit.objectID)) return null;
  const thread = hnThreadUrl(hit.objectID);
  const article = hit.url && /^https?:\/\//i.test(hit.url) ? hit.url : undefined;
  const storyHtml = hit.story_text ?? "";
  const storyText = storyHtml ? htmlToText(storyHtml) : "";
  const created = num(hit.created_at_i);
  const publishedAt = created !== undefined ? created * 1000 : hit.created_at ? Date.parse(hit.created_at) : undefined;
  const points = num(hit.points) ?? 0;
  const comments = num(hit.num_comments) ?? 0;
  return {
    externalId: hit.objectID,
    url: article ?? thread,
    title,
    ...(str(hit.author) ? { author: str(hit.author) } : {}),
    ...(publishedAt !== undefined && Number.isFinite(publishedAt) ? { publishedAt } : {}),
    kind: "discussion",
    text: itemText(storyText ? `${title}\n\n${storyText}` : title),
    links: itemLinks([article, thread, ...extractLinks(storyHtml)]),
    meta: { site: "hn", points, comments, threadUrl: thread },
  };
}

export async function fetchHn(args: {
  config: HnConfig;
  cursor: unknown;
  mode: "preview" | "poll";
  limit: number;
  ctx: ConnectorContext;
  maxAgeDays: number;
}): Promise<FetchResult<CommunityCursor>> {
  const { config, mode, limit, ctx } = args;
  const cursor = mode === "poll" ? readCursor(args.cursor, "hn") : null;
  const sinceSec = Math.floor(ctx.now() / 1000) - args.maxAgeDays * 86_400;
  const hitsPerPage = mode === "preview" ? previewCount(limit) : Math.min(100, Math.max(50, limit));
  const url = hnSearchUrl(config, hitsPerPage, sinceSec);
  const res = await send(
    ctx,
    {
      url,
      headers: { Accept: "application/json" },
      ...(cursor?.etag ? { etag: cursor.etag } : {}),
      ...(cursor?.lastModified ? { lastModified: cursor.lastModified } : {}),
    },
    WHAT,
  );
  if (res.notModified && cursor) return { items: [], cursor };
  checkStatus(res, WHAT, "Hacker News search answered 404.");
  const body = searchSchema.safeParse(parseJson(res.text, WHAT));
  if (!body.success) throw new ConnectorError("bad_response", `${WHAT} sent an answer with no list of stories.`);

  // The thresholds apply in the connector too (the API filter is the first line).
  const items = body.data.hits
    .map(hnHitToItem)
    .filter((item): item is RawItem => item !== null)
    .filter((item) => {
      const meta = item.meta as { points: number; comments: number };
      return meta.points >= config.minPoints && meta.comments >= config.minComments;
    })
    .filter((item) => item.publishedAt === undefined || item.publishedAt > sinceSec * 1000);

  if (mode === "preview") {
    return { items: selectNew(items, null, previewCount(limit)).items, cursor: null };
  }
  const picked = selectNew(items, cursor?.seenIds ?? null, limit);
  return {
    items: picked.items,
    cursor: {
      variant: "hn",
      seenIds: picked.seenIds,
      ...(res.etag ? { etag: res.etag } : {}),
      ...(res.lastModified ? { lastModified: res.lastModified } : {}),
    },
  };
}

// --- resolve ------------------------------------------------------------------

function hnCandidate(config: HnConfig, confidence: number, warnings?: string[]): Candidate {
  const days = SOURCE_TYPE_DEFAULTS.community.maxAgeDays;
  const name = config.query ? `Hacker News: "${config.query}"` : "Hacker News front page";
  const what = config.query ? `stories that match "${config.query}"` : "front-page stories";
  const threshold = `at least ${config.minPoints} points${config.minComments > 0 ? ` and ${config.minComments} comments` : ""}`;
  return {
    type: "community",
    name: name.slice(0, 120),
    description: `Hacker News ${what} with ${threshold}, from the last ${days} days.`,
    url: config.query
      ? `https://hn.algolia.com/?dateRange=pastWeek&query=${encodeURIComponent(config.query)}&sort=byDate&type=story`
      : "https://news.ycombinator.com/",
    config,
    confidence,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

const hnQuery = (query: string | null): HnConfig => ({
  variant: "hn",
  query: query === null ? null : query.trim().slice(0, 300),
  minPoints: 50,
  minComments: 0,
});

/** The HN candidates for a URL (news.ycombinator.com, hn.algolia.com), or null when the URL is not for HN. */
export function resolveHnUrl(url: URL): Candidate[] | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "news.ycombinator.com" || host === "ycombinator.com") {
    if (host === "ycombinator.com") return null;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/item") {
      return [
        hnCandidate(hnQuery(null), 0.4, ["This link is one Hacker News thread. The candidate follows the front page instead."]),
      ];
    }
    return [hnCandidate(hnQuery(null), 0.95)];
  }
  if (host === "hn.algolia.com") {
    const query = url.searchParams.get("query")?.trim() || url.searchParams.get("q")?.trim() || "";
    return [hnCandidate(hnQuery(query === "" ? null : query), 0.95)];
  }
  return null;
}

/** "hn: words", "hacker news: words", "hn", "hacker news". null when the text has no HN prefix. */
export function resolveHnText(text: string): Candidate[] | null {
  const trimmed = text.trim();
  if (/^(?:hn|hacker\s*news)$/i.test(trimmed)) return [hnCandidate(hnQuery(null), 0.9)];
  const match = /^(?:hn|hacker\s*news)\s*:\s*(.+)$/i.exec(trimmed);
  if (!match || !match[1]) return null;
  const words = match[1].trim().replace(/^["']|["']$/g, "").trim();
  if (words === "") return [hnCandidate(hnQuery(null), 0.9)];
  return [hnCandidate(hnQuery(words), 0.95)];
}

/** A Hacker News search candidate for plain topic text. */
export function hnTextCandidate(text: string, forced: boolean): Candidate {
  return hnCandidate(hnQuery(text), forced ? 0.7 : 0.3);
}
