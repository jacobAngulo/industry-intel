// Finds the feed of a site (blog and newsletter, §6.3): the address itself,
// then <link rel="alternate">, then the common paths.
import { NotAFeedError, discoverFeeds, parseFeed, type ParsedFeed } from "@/lib/feeds";
import type { HttpResponse } from "@/lib/http/types";

import { ConnectorError, type ConnectorContext } from "../types";
import { FEED_ACCEPT, assertOk, httpGet } from "./http";

export interface FoundFeed {
  feedUrl: string;
  feed: ParsedFeed;
  via: "direct" | "link" | "probe";
}

export interface FindFeedsResult {
  /** The final address of the page. */
  pageUrl: string;
  /** The HTML of the page ('' when the address is a feed). */
  html: string;
  feeds: FoundFeed[];
}

/** The common feed paths of §6.3, in the order of the probe. */
export const COMMON_FEED_PATHS = ["feed", "rss", "rss.xml", "atom.xml", "index.xml", "feed.xml"] as const;
/** The most probe requests for one site. */
export const MAX_PROBES = 6;
/** The most <link rel="alternate"> feeds that are fetched. */
export const MAX_LINKED_FEEDS = 3;

function tryParse(text: string, url: string): ParsedFeed | null {
  try {
    return parseFeed(text, url);
  } catch (error) {
    if (error instanceof NotAFeedError) return null;
    return null;
  }
}

/** The probe addresses: below the path of the page when it has one, else at the root. */
export function probeUrls(pageUrl: string, preferred: readonly string[] = []): string[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [];
  }
  let dir = url.pathname.replace(/\/+$/, "");
  // A page file ("/blog/index.html") probes its folder.
  if (/\.[a-z0-9]{2,5}$/i.test(dir)) dir = dir.replace(/\/[^/]*$/, "");
  const out: string[] = [];
  for (const path of [...preferred, ...COMMON_FEED_PATHS]) {
    const candidate = path.startsWith("/") ? `${url.origin}${path}` : `${url.origin}${dir}/${path}`;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out.slice(0, MAX_PROBES);
}

/**
 * Finds the feeds of an address. `first` is the response of the address when
 * the caller fetched it already. `preferredPaths` go before the common paths
 * (a path that starts with "/" is at the root; the others are below the page).
 * Throws a ConnectorError when the address itself does not answer.
 */
export async function findFeeds(
  ctx: ConnectorContext,
  address: string,
  options: { first?: HttpResponse; preferredPaths?: readonly string[] } = {},
): Promise<FindFeedsResult> {
  const res = options.first ?? (await httpGet(ctx, address, { accept: `text/html;q=0.9, ${FEED_ACCEPT}` }));
  assertOk(res, "The address");
  const pageUrl = res.url || address;

  const direct = tryParse(res.text, pageUrl);
  if (direct) return { pageUrl, html: "", feeds: [{ feedUrl: pageUrl, feed: direct, via: "direct" }] };

  const html = res.text;
  const feeds: FoundFeed[] = [];
  for (const feedUrl of discoverFeeds(html, pageUrl).slice(0, MAX_LINKED_FEEDS)) {
    try {
      const r = await httpGet(ctx, feedUrl, { accept: FEED_ACCEPT });
      if (!r.ok) continue;
      const feed = tryParse(r.text, r.url || feedUrl);
      if (feed && !feeds.some((f) => f.feedUrl === (r.url || feedUrl))) feeds.push({ feedUrl: r.url || feedUrl, feed, via: "link" });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
    }
  }
  if (feeds.length > 0) return { pageUrl, html, feeds };

  for (const probe of probeUrls(pageUrl, options.preferredPaths)) {
    try {
      const r = await httpGet(ctx, probe, { accept: FEED_ACCEPT });
      if (!r.ok) continue;
      const feed = tryParse(r.text, r.url || probe);
      if (feed) return { pageUrl, html, feeds: [{ feedUrl: r.url || probe, feed, via: "probe" }] };
    } catch (error) {
      if (ctx.signal?.aborted || !(error instanceof ConnectorError)) throw error;
    }
  }
  return { pageUrl, html, feeds: [] };
}
