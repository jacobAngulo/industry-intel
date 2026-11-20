// Helpers that the three community variants share: the cursor, the HTTP call
// with the error mapping, and the item limits of §6.2.
import { z } from "zod";

import { HttpError, type HttpRequest, type HttpResponse } from "@/lib/http/types";
import { canonicalizeUrl, stripInvisible, truncate } from "@/lib/text";

import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type ConnectorContext, type RawItem } from "../types";

/** The most ids that a cursor keeps. */
export const MAX_SEEN_IDS = 500;

/**
 * The cursor of a community source. `seenIds` holds the external ids that the
 * source returned before (newest first). `etag` / `lastModified` are kept for
 * a conditional GET when the host sends them (none of the three hosts did on
 * 2026-11-20).
 */
export interface CommunityCursor {
  variant: "hn" | "reddit" | "discourse";
  seenIds: string[];
  etag?: string;
  lastModified?: string;
}

export const communityCursorSchema = z.object({
  variant: z.enum(["hn", "reddit", "discourse"]),
  seenIds: z.array(z.string()).max(5000),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
});

/** A stored cursor of the same variant, or null (a cursor of another shape counts as no cursor). */
export function readCursor(cursor: unknown, variant: CommunityCursor["variant"]): CommunityCursor | null {
  const parsed = communityCursorSchema.safeParse(cursor);
  if (!parsed.success || parsed.data.variant !== variant) return null;
  return parsed.data as CommunityCursor;
}

/** The host of a URL for messages, or the URL itself. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One GET (or POST) through ctx.http. HttpError becomes a ConnectorError.
 * The caller reads the status.
 */
export async function send(ctx: ConnectorContext, req: HttpRequest, what: string): Promise<HttpResponse> {
  try {
    return await ctx.http.request({ ...(ctx.signal ? { signal: ctx.signal } : {}), ...req });
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof HttpError) {
      switch (error.kind) {
        case "bad_url":
        case "blocked_address":
          throw new ConnectorError("blocked", `The app does not connect to ${hostOf(req.url)}: the address is not allowed.`, {
            cause: error,
          });
        case "too_large":
          throw new ConnectorError("bad_response", `${what} sent a response that is too large.`, { cause: error });
        case "timeout":
          throw new ConnectorError("network", `${what} did not answer in time. The app tries again later.`, { cause: error });
        default:
          throw new ConnectorError("network", `Could not reach ${what}. The app tries again later.`, { cause: error });
      }
    }
    throw new ConnectorError("network", `Could not reach ${what}. The app tries again later.`, { cause: error });
  }
}

/** Throws the ConnectorError for a status that is not OK (and not 304). */
export function checkStatus(res: HttpResponse, what: string, notFound: string): void {
  if (res.notModified || res.ok) return;
  if (res.status === 404 || res.status === 410) throw new ConnectorError("not_found", notFound);
  if (res.status === 429) throw new ConnectorError("rate_limited", `${what} limits the requests of this server now. The app tries again later.`);
  if (res.status === 401 || res.status === 403) throw new ConnectorError("blocked", `${what} refused the request (status ${res.status}).`);
  if (res.status >= 500) throw new ConnectorError("network", `${what} answered with a server error (status ${res.status}). The app tries again later.`);
  throw new ConnectorError("bad_response", `${what} answered with status ${res.status}.`);
}

/** JSON.parse with a ConnectorError of kind bad_response. */
export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConnectorError("bad_response", `${what} did not send valid JSON.`, { cause: error });
  }
}

/** Plain text for RawItem.text: invisible characters removed, at most 20 000 characters. */
export function itemText(text: string): string {
  return truncate(stripInvisible(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), RAW_ITEM_MAX_TEXT);
}

/** Absolute http(s) links, canonical, no duplicates, at most 10. */
export function itemLinks(links: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!link || !/^https?:\/\//i.test(link)) continue;
    let canonical: string;
    try {
      canonical = canonicalizeUrl(new URL(link).href);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= RAW_ITEM_MAX_LINKS) break;
  }
  return out;
}

/** Newest first; items with no date last. */
export function newestFirst(items: RawItem[]): RawItem[] {
  return [...items].sort((a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity));
}

/**
 * The poll rule of the community and research connectors:
 * - first poll (no cursor): the newest `limit` items; every listed id counts as seen;
 * - later polls: the newest `limit` items that the cursor has not seen; the rest stay for the next poll.
 */
export function selectNew(
  all: RawItem[],
  cursorSeen: string[] | null,
  limit: number,
): { items: RawItem[]; seenIds: string[] } {
  const sorted = newestFirst(all);
  const max = Math.max(0, limit);
  if (cursorSeen === null) {
    return { items: sorted.slice(0, max), seenIds: sorted.map((item) => item.externalId).slice(0, MAX_SEEN_IDS) };
  }
  const seen = new Set(cursorSeen);
  const fresh = sorted.filter((item) => !seen.has(item.externalId)).slice(0, max);
  const ids = [...fresh.map((item) => item.externalId), ...cursorSeen];
  return { items: fresh, seenIds: [...new Set(ids)].slice(0, MAX_SEEN_IDS) };
}

/** The item count of a preview: 1 to 10. */
export function previewCount(limit: number): number {
  return Math.max(1, Math.min(10, Math.floor(limit) || 1));
}

/** A finite number, else undefined. */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A string that is not empty after trim, else undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Epoch ms of an ISO date text, else undefined. */
export function isoTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Waits `ms` milliseconds, or stops early with a network error when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectorError("network", "The check was stopped."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ConnectorError("network", "The check was stopped."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parses an http(s) URL typed by a person ("www.x.com/…" counts too). null when it is not one. */
export function parseInputUrl(input: string): URL | null {
  const text = input.trim();
  if (text === "" || /\s/.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(text) ? `https://${text}` : null;
  if (withScheme === null) return null;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
