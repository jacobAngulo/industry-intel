// Page-level helpers of the docs connector: the title, the links of the page by their text, and the
// test that a response is a feed and not a page.
import { decodeEntities, normalizeForHash, stripInvisible, truncate } from "@/lib/text";
import { parseAttributes } from "@/lib/text/attrs";

function oneLine(text: string): string {
  return stripInvisible(decodeEntities(text.replace(/<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();
}

/** The title of a page: og:title, then <title>, then the first <h1>, then the host and path. */
export function pageTitle(html: string, url: string): string {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = parseAttributes(match[1] ?? "");
    if ((a["property"] ?? a["name"] ?? "").toLowerCase() === "og:title") {
      const value = oneLine(a["content"] ?? "");
      if (value !== "") return truncate(value, 200);
    }
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1] && oneLine(title[1]) !== "") return truncate(oneLine(title[1]), 200);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1?.[1] && oneLine(h1[1]) !== "") return truncate(oneLine(h1[1]), 200);
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/**
 * Content that a page hides with `visibility: hidden` until a script runs (for example the news
 * list of anthropic.com/news, checked on 2026-11-20) is content: the style is removed before the
 * page is split. `display: none` and the `hidden` attribute stay hidden.
 */
export function revealDeferredContent(html: string): string {
  return html.replace(/\sstyle\s*=\s*(["'])([^"']*)\1/gi, (whole, quote: string, style: string) => {
    if (!/visibility\s*:\s*hidden/i.test(style)) return whole;
    const rest = style.replace(/visibility\s*:\s*hidden\s*;?/gi, "").trim();
    return rest === "" ? "" : ` style=${quote}${rest}${quote}`;
  });
}

/**
 * The absolute http(s) address of each link of the page, keyed by the normalized link text.
 * Used to give a new line of a section its link (for example a new article in a list).
 */
export function linksByText(html: string, baseUrl: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (parseAttributes(match[1] ?? "")["href"] ?? "").trim();
    if (href === "" || href.startsWith("#")) continue;
    let absolute: string;
    try {
      absolute = new URL(decodeEntities(href), baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(absolute)) continue;
    const key = normalizeForHash(oneLine(match[2] ?? ""));
    if (key.length < 3 || out.has(key)) continue;
    out.set(key, absolute);
    if (out.size >= 2000) break;
  }
  return out;
}

/** The links of the given lines, from the link text of the page (at most `max`). */
export function linksForLines(lines: string[], byText: Map<string, string>, max: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const key = normalizeForHash(line.replace(/^\s*-\s+/, ""));
    const link = byText.get(key);
    if (link !== undefined && !out.includes(link)) out.push(link);
    if (out.length >= max) break;
  }
  return out;
}

/** True when the response is a feed (RSS, Atom, JSON Feed), not a page. */
export function looksLikeFeed(contentType: string | undefined, body: string): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (/(rss|atom|feed\+json)/.test(type)) return true;
  const start = body.replace(/^[\s﻿]+/, "").slice(0, 500).toLowerCase();
  if (start.startsWith("<?xml") || start.startsWith("<rss") || start.startsWith("<feed") || start.startsWith("<rdf:rdf")) {
    return !/<html[\s>]/i.test(body.slice(0, 2000));
  }
  if (start.startsWith("{") && /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(body.slice(0, 2000))) return true;
  return false;
}
