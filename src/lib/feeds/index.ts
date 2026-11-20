/**
 * Feed parsing for the connectors (§11.2 of the specification): RSS 2.0, RSS 1.0 (RDF), Atom 1.0,
 * and JSON Feed 1.x. No function here makes a network call.
 */
import { decodeEntities, htmlToText, sha, stripInvisible, truncate } from "@/lib/text";
import { parseAttributes } from "@/lib/text/attrs";

import { parseDate } from "./dates";
import {
  asArray, attr, decodeRaw, first, isObject, parseXml, rawOf, simplify, textOf, type XmlNode, type XmlObject,
} from "./xml";

export { parseDate, parseDuration } from "./dates";

export interface ParsedFeed {
  title: string;
  siteUrl?: string;
  entries: FeedEntry[];
}

export interface FeedEntry {
  /** guid / id, else the link, else a hash of the title and the date. */
  id: string;
  title: string;
  link?: string;
  author?: string;
  /** Epoch ms. undefined when the entry has no valid date. */
  publishedAt?: number;
  /** The fullest content field, as HTML. */
  html?: string;
  /** The plain text of `html` (or the plain-text content of the entry). */
  text: string;
  categories: string[];
  enclosure?: { url: string; type?: string; length?: number };
  /**
   * Namespaced fields as parsed, for example "podcast:transcript" (always an array of
   * `{ url, type, language?, rel? }`), "itunes:duration", "itunes:episode", "media:group" (with
   * "media:description" and "media:thumbnail"), "yt:videoId", "yt:channelId", and "updatedAt"
   * (epoch ms of the Atom `updated` value).
   */
  extra: Record<string, unknown>;
}

export const NOT_A_FEED_MESSAGE = "This address did not return a feed";

/** The document is not a feed that `parseFeed` can read. The message is fit to show to a person. */
export class NotAFeedError extends Error {
  constructor() {
    super(NOT_A_FEED_MESSAGE);
    this.name = "NotAFeedError";
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

const KNOWN_INLINE_TAG =
  /<\/?(?:a|abbr|b|br|cite|code|del|div|em|font|h[1-6]|i|img|ins|kbd|mark|p|q|s|small|span|strong|sub|sup|tt|u|var)\b[^>]*>/gi;

/** A title as one line of plain text. Unknown tags stay as text ("Using the <canvas> element"). */
function titleText(value: string): string {
  let s = value;
  if (s.includes("<")) s = s.replace(KNOWN_INLINE_TAG, (tag) => (/^<\/?(?:br|p|div|h[1-6])\b/i.test(tag) ? " " : ""));
  return stripInvisible(decodeEntities(s)).replace(/\s+/g, " ").trim();
}

function resolveUrl(href: string | undefined, bases: Array<string | undefined>): string | undefined {
  const value = (href ?? "").trim();
  if (value === "") return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return undefined; // mailto:, javascript:, tag:, …
  for (const base of bases) {
    if (base === undefined || !/^https?:\/\//i.test(base)) continue;
    try {
      return new URL(value, base).href;
    } catch {
      // Try the next base.
    }
  }
  return undefined;
}

function looksLikeHtml(text: string): boolean {
  return /<[a-zA-Z!/][^>]*>/.test(text) || /&(?:#\d+|#x[0-9a-f]+|[a-z]+[0-9]*);/i.test(text);
}

interface Body {
  html?: string;
  text: string;
}

/** Plain text with the space rules of `htmlToText`: lines stay, runs of spaces collapse. */
function plainText(value: string): string {
  return stripInvisible(value)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The fullest of the candidates. A candidate is HTML, or plain text (`plain: true`). Plain text that
 * holds markup is read as HTML, unless the feed declares it as text (`strict: true`).
 */
function pickBody(candidates: Array<{ value: string; plain?: boolean; strict?: boolean }>): Body {
  let best: Body = { text: "" };
  for (const c of candidates) {
    const value = c.value.trim();
    if (value === "") continue;
    const body: Body =
      c.plain === true && (c.strict === true || !looksLikeHtml(value))
        ? { text: plainText(value) }
        : { html: value, text: stripInvisible(htmlToText(value)) };
    if (body.text.length > best.text.length) best = body;
  }
  return best;
}

function addCategory(list: string[], value: string | undefined): void {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  if (v === "" || v.length > 200) return;
  const lower = v.toLowerCase();
  if (!list.some((c) => c.toLowerCase() === lower)) list.push(v);
}

function toLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A name from an RSS <author> value: "mail@example.com (Name)" or "Name <mail@example.com>". */
function personName(value: string): string | undefined {
  const v = value.replace(/\s+/g, " ").trim();
  if (v === "") return undefined;
  const inParens = /\(([^)]+)\)\s*$/.exec(v);
  if (inParens?.[1] !== undefined && v.includes("@")) return inParens[1].trim() || undefined;
  const beforeAngle = /^([^<]+)<[^>]*@[^>]*>$/.exec(v);
  if (beforeAngle?.[1] !== undefined) return beforeAngle[1].trim() || undefined;
  if (/^\S+@\S+\.\S+$/.test(v)) return undefined; // an address only: not a name
  return truncate(v, 200);
}

const EXTRA_SKIP = new Set([
  "content:encoded", "itunes:summary", "podcast:transcript", "media:group", "atom:link", "dc:creator", "dc:date",
]);
const MAX_EXTRA_KEYS = 60;

/** Copies the namespaced children of an entry element to `extra`. */
function collectExtra(node: XmlObject, bases: Array<string | undefined>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(node)) {
    if (!key.includes(":") || key.startsWith("@_") || EXTRA_SKIP.has(key) || key.startsWith("xmlns")) continue;
    if (count >= MAX_EXTRA_KEYS) break;
    const simple = simplify(value);
    if (simple === "") continue;
    extra[key] = simple;
    count += 1;
  }

  const transcripts: Array<{ url: string; type: string; language?: string; rel?: string }> = [];
  for (const t of asArray(node["podcast:transcript"])) {
    const url = resolveUrl(attr(t, "url"), bases);
    if (url === undefined) continue;
    const entry: { url: string; type: string; language?: string; rel?: string } = { url, type: attr(t, "type") ?? "" };
    const language = attr(t, "language");
    if (language !== undefined && language !== "") entry.language = language;
    const rel = attr(t, "rel");
    if (rel !== undefined && rel !== "") entry.rel = rel;
    transcripts.push(entry);
  }
  if (transcripts.length > 0) extra["podcast:transcript"] = transcripts;

  const group = first(node["media:group"]);
  if (isObject(group)) {
    const simple = simplify(group);
    const out: Record<string, unknown> = typeof simple === "object" && simple !== null ? { ...simple } : {};
    const description = textOf(group["media:description"]);
    if (description !== "") out["media:description"] = description;
    const thumbnail = first(group["media:thumbnail"]);
    if (thumbnail !== undefined) out["media:thumbnail"] = simplify(thumbnail);
    extra["media:group"] = out;
  }
  return extra;
}

function fallbackId(title: string, publishedAt: number | undefined, text: string): string {
  return sha(`${title}\n${publishedAt ?? ""}\n${publishedAt === undefined && title === "" ? text.slice(0, 500) : ""}`);
}

function fallbackTitle(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return truncate(firstLine.trim(), 100);
}

// ---------------------------------------------------------------------------------------------
// RSS 2.0 and RSS 1.0

function rssAuthor(item: XmlObject): string | undefined {
  const creator = textOf(item["dc:creator"]);
  if (creator !== "") return truncate(titleText(creator), 200);
  const author = first(item["author"]);
  if (author !== undefined) {
    // An Atom-style <author><name> inside an RSS item is also in use.
    const name = isObject(author) && author["name"] !== undefined ? textOf(author["name"]) : textOf(author);
    const person = personName(name);
    if (person !== undefined) return person;
  }
  const itunes = textOf(item["itunes:author"]);
  return itunes !== "" ? truncate(titleText(itunes), 200) : undefined;
}

function rssEntry(item: XmlObject, feedBases: Array<string | undefined>, feedAuthor: string | undefined): FeedEntry {
  const bases = [attr(item, "xml:base"), ...feedBases];
  const guidNode = first(item["guid"]);
  const guid = textOf(guidNode);

  let link = resolveUrl(textOf(item["link"]), bases);
  if (link === undefined) {
    for (const l of asArray(item["atom:link"])) {
      const rel = attr(l, "rel") ?? "alternate";
      if (rel === "alternate") link = resolveUrl(attr(l, "href"), bases);
      if (link !== undefined) break;
    }
  }
  if (link === undefined && guid !== "" && (attr(guidNode, "isPermaLink") ?? "true").toLowerCase() !== "false") {
    link = resolveUrl(guid, []);
  }

  const publishedAt =
    parseDate(textOf(item["pubDate"])) ??
    parseDate(textOf(item["dc:date"])) ??
    parseDate(textOf(item["published"])) ??
    parseDate(textOf(item["updated"])) ??
    parseDate(textOf(item["atom:published"])) ??
    parseDate(textOf(item["atom:updated"]));

  const group = first(item["media:group"]);
  const body = pickBody([
    { value: textOf(item["content:encoded"]) },
    { value: textOf(item["description"]) },
    { value: decodeRaw(rawOf(item["content"])) },
    { value: decodeRaw(rawOf(item["summary"])) },
    { value: textOf(item["itunes:summary"]) },
    { value: textOf(item["media:description"]), plain: true },
    { value: isObject(group) ? textOf(group["media:description"]) : "", plain: true },
  ]);

  const categories: string[] = [];
  for (const c of asArray(item["category"])) addCategory(categories, titleText(textOf(c)));
  for (const c of asArray(item["dc:subject"])) addCategory(categories, titleText(textOf(c)));

  let enclosure: FeedEntry["enclosure"];
  for (const e of asArray(item["enclosure"])) {
    const url = resolveUrl(attr(e, "url"), bases);
    if (url === undefined) continue;
    enclosure = { url };
    const type = attr(e, "type");
    if (type !== undefined && type !== "") enclosure.type = type;
    const length = toLength(attr(e, "length"));
    if (length !== undefined) enclosure.length = length;
    break;
  }

  let title = titleText(decodeRaw(rawOf(item["title"])));
  if (title === "") title = titleText(textOf(item["itunes:title"]));
  if (title === "") title = fallbackTitle(body.text);

  const entry: FeedEntry = {
    id: guid || attr(item, "rdf:about") || link || fallbackId(title, publishedAt, body.text),
    title,
    text: body.text,
    categories,
    extra: collectExtra(item, bases),
  };
  if (link !== undefined) entry.link = link;
  const author = rssAuthor(item) ?? feedAuthor;
  if (author !== undefined) entry.author = author;
  if (publishedAt !== undefined) entry.publishedAt = publishedAt;
  if (body.html !== undefined) entry.html = body.html;
  if (enclosure !== undefined) entry.enclosure = enclosure;
  return entry;
}

function parseRss(root: XmlObject, rootName: string, baseUrl: string | undefined): ParsedFeed {
  const channel = first(root["channel"]);
  if (!isObject(channel)) throw new NotAFeedError();
  let siteUrl: string | undefined;
  for (const l of asArray(channel["link"])) {
    siteUrl = resolveUrl(textOf(l), [attr(channel, "xml:base"), attr(root, "xml:base"), baseUrl]);
    if (siteUrl !== undefined) break;
  }
  const bases = [attr(channel, "xml:base"), attr(root, "xml:base"), siteUrl, baseUrl];
  // RSS 1.0 has the items next to the channel; RSS 2.0 has them inside.
  const items = rootName === "rdf:rdf" ? [...asArray(root["item"]), ...asArray(channel["item"])] : asArray(channel["item"]);
  // A podcast names its author one time, for the show.
  const showAuthor = titleText(textOf(channel["itunes:author"]));
  const feedAuthor = showAuthor !== "" ? truncate(showAuthor, 200) : undefined;
  const feed: ParsedFeed = {
    title: titleText(decodeRaw(rawOf(channel["title"]))),
    entries: items.filter(isObject).map((item) => rssEntry(item, bases, feedAuthor)),
  };
  if (siteUrl !== undefined) feed.siteUrl = siteUrl;
  return feed;
}

// ---------------------------------------------------------------------------------------------
// Atom

/** An Atom text construct as HTML or as plain text. */
function atomConstruct(node: XmlNode | undefined): { value: string; plain: boolean; strict?: boolean } {
  const n = first(node);
  if (n === undefined) return { value: "", plain: true };
  const declared = attr(n, "type");
  const type = (declared ?? "text").toLowerCase();
  const raw = rawOf(n);
  if (type === "xhtml" || type === "application/xhtml+xml") {
    // The content is markup already: only the CDATA marks go.
    return { value: raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim(), plain: false };
  }
  if (type === "html" || type === "text/html") return { value: decodeRaw(raw).trim(), plain: false };
  if (type === "text" || type.startsWith("text/")) {
    // Many feeds leave the type out and still send HTML: only a declared type is taken at its word.
    return { value: decodeRaw(raw).trim(), plain: true, strict: declared !== undefined };
  }
  return { value: "", plain: true }; // other media types (base64 data) are not text
}

function atomTitle(node: XmlNode | undefined): string {
  const c = atomConstruct(node);
  if (c.value === "") return "";
  return c.plain ? titleText(c.value) : stripInvisible(htmlToText(c.value)).replace(/\s+/g, " ").trim();
}

function atomAuthor(node: XmlObject): string | undefined {
  for (const a of asArray(node["author"])) {
    const name = isObject(a) ? textOf(a["name"]) : textOf(a);
    const person = personName(name);
    if (person !== undefined) return person;
  }
  const creator = textOf(node["dc:creator"]) || textOf(node["itunes:author"]);
  return creator !== "" ? truncate(titleText(creator), 200) : undefined;
}

function atomLink(node: XmlObject, rel: string, bases: Array<string | undefined>): XmlNode | undefined {
  let fallback: XmlNode | undefined;
  for (const l of asArray(node["link"])) {
    if ((attr(l, "rel") ?? "alternate").toLowerCase() !== rel) continue;
    if (resolveUrl(attr(l, "href"), bases) === undefined) continue;
    const type = (attr(l, "type") ?? "").toLowerCase();
    if (rel !== "alternate" || type === "" || type.includes("html")) return l;
    fallback ??= l;
  }
  return fallback;
}

function atomEntry(entry: XmlObject, feedBases: Array<string | undefined>, feedAuthor: string | undefined): FeedEntry {
  const bases = [attr(entry, "xml:base"), ...feedBases];
  const link = resolveUrl(attr(atomLink(entry, "alternate", bases), "href"), bases);

  const updatedAt = parseDate(textOf(entry["updated"])) ?? parseDate(textOf(entry["modified"]));
  const publishedAt =
    parseDate(textOf(entry["published"])) ??
    parseDate(textOf(entry["issued"])) ??
    updatedAt ??
    parseDate(textOf(entry["dc:date"])) ??
    parseDate(textOf(entry["created"]));

  const group = first(entry["media:group"]);
  const content = atomConstruct(entry["content"]);
  const summary = atomConstruct(entry["summary"]);
  const body = pickBody([
    content,
    summary,
    { value: textOf(entry["content:encoded"]) },
    { value: isObject(group) ? textOf(group["media:description"]) : "", plain: true },
    { value: textOf(entry["media:description"]), plain: true },
  ]);

  const categories: string[] = [];
  for (const c of asArray(entry["category"])) {
    addCategory(categories, attr(c, "label"));
    addCategory(categories, attr(c, "term"));
    if (!isObject(c)) addCategory(categories, textOf(c));
  }

  let enclosure: FeedEntry["enclosure"];
  const enclosureLink = atomLink(entry, "enclosure", bases);
  const enclosureUrl = resolveUrl(attr(enclosureLink, "href"), bases);
  if (enclosureUrl !== undefined) {
    enclosure = { url: enclosureUrl };
    const type = attr(enclosureLink, "type");
    if (type !== undefined && type !== "") enclosure.type = type;
    const length = toLength(attr(enclosureLink, "length"));
    if (length !== undefined) enclosure.length = length;
  }

  let title = atomTitle(entry["title"]);
  if (title === "" && isObject(group)) title = titleText(textOf(group["media:title"]));
  if (title === "") title = fallbackTitle(body.text);

  const extra = collectExtra(entry, bases);
  if (updatedAt !== undefined) extra["updatedAt"] = updatedAt;

  const out: FeedEntry = {
    id: textOf(entry["id"]) || link || fallbackId(title, publishedAt, body.text),
    title,
    text: body.text,
    categories,
    extra,
  };
  if (link !== undefined) out.link = link;
  const author = atomAuthor(entry) ?? feedAuthor;
  if (author !== undefined) out.author = author;
  if (publishedAt !== undefined) out.publishedAt = publishedAt;
  if (body.html !== undefined) out.html = body.html;
  if (enclosure !== undefined) out.enclosure = enclosure;
  return out;
}

function parseAtom(root: XmlObject, baseUrl: string | undefined): ParsedFeed {
  const rootBases = [attr(root, "xml:base"), baseUrl];
  const siteUrl = resolveUrl(attr(atomLink(root, "alternate", rootBases), "href"), rootBases);
  const bases = [attr(root, "xml:base"), siteUrl, baseUrl];
  const feedAuthor = atomAuthor(root);
  const feed: ParsedFeed = {
    title: atomTitle(root["title"]),
    entries: asArray(root["entry"]).filter(isObject).map((entry) => atomEntry(entry, bases, feedAuthor)),
  };
  if (siteUrl !== undefined) feed.siteUrl = siteUrl;
  return feed;
}

// ---------------------------------------------------------------------------------------------
// JSON Feed

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function jsonAuthor(node: Json): string | undefined {
  const authors = Array.isArray(node["authors"]) ? node["authors"] : [node["author"]];
  for (const a of authors) {
    const name = isJson(a) ? str(a["name"]) : "";
    if (name !== "") return truncate(name.replace(/\s+/g, " "), 200);
  }
  return undefined;
}

function jsonEntry(item: Json, bases: Array<string | undefined>, feedAuthor: string | undefined): FeedEntry {
  const link = resolveUrl(str(item["url"]), bases) ?? resolveUrl(str(item["external_url"]), bases);
  const modifiedAt = parseDate(item["date_modified"]);
  const publishedAt = parseDate(item["date_published"]) ?? modifiedAt;

  const contentHtml = str(item["content_html"]);
  const contentText = str(item["content_text"]);
  let body = pickBody([{ value: contentHtml }, { value: str(item["summary"]), plain: true }]);
  if (contentText !== "" && (contentHtml === "" || contentText.length > body.text.length)) {
    // The plain-text content is used as it is (`content_text` has no markup).
    body = { ...(contentHtml !== "" ? { html: contentHtml } : {}), text: plainText(contentText) };
  }

  const categories: string[] = [];
  if (Array.isArray(item["tags"])) for (const t of item["tags"]) addCategory(categories, str(t));

  let enclosure: FeedEntry["enclosure"];
  if (Array.isArray(item["attachments"])) {
    for (const a of item["attachments"]) {
      if (!isJson(a)) continue;
      const url = resolveUrl(str(a["url"]), bases);
      if (url === undefined) continue;
      enclosure = { url };
      if (str(a["mime_type"]) !== "") enclosure.type = str(a["mime_type"]);
      if (typeof a["size_in_bytes"] === "number" && Number.isSafeInteger(a["size_in_bytes"])) enclosure.length = a["size_in_bytes"];
      break;
    }
  }

  const extra: Record<string, unknown> = {};
  for (const key of ["external_url", "image", "banner_image", "language"]) {
    if (str(item[key]) !== "") extra[key] = str(item[key]);
  }
  for (const [key, value] of Object.entries(item)) {
    if (key.startsWith("_") && key !== "__proto__" && Object.keys(extra).length < MAX_EXTRA_KEYS) extra[key] = value;
  }
  if (modifiedAt !== undefined) extra["updatedAt"] = modifiedAt;

  let title = titleText(str(item["title"]));
  if (title === "") title = fallbackTitle(body.text);
  const out: FeedEntry = {
    id: str(item["id"]) || link || fallbackId(title, publishedAt, body.text),
    title,
    text: body.text,
    categories,
    extra,
  };
  if (link !== undefined) out.link = link;
  const author = jsonAuthor(item) ?? feedAuthor;
  if (author !== undefined) out.author = author;
  if (publishedAt !== undefined) out.publishedAt = publishedAt;
  if (body.html !== undefined) out.html = body.html;
  if (enclosure !== undefined) out.enclosure = enclosure;
  return out;
}

function parseJsonFeed(source: string, baseUrl: string | undefined): ParsedFeed {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new NotAFeedError();
  }
  if (!isJson(data) || !Array.isArray(data["items"])) throw new NotAFeedError();
  const version = str(data["version"]);
  if (!version.includes("jsonfeed.org") && typeof data["title"] !== "string") throw new NotAFeedError();
  const siteUrl = resolveUrl(str(data["home_page_url"]), [baseUrl]);
  const bases = [resolveUrl(str(data["feed_url"]), [baseUrl]), siteUrl, baseUrl];
  const feedAuthor = jsonAuthor(data);
  const feed: ParsedFeed = {
    title: titleText(str(data["title"])),
    entries: data["items"].filter(isJson).map((item) => jsonEntry(item, bases, feedAuthor)),
  };
  if (siteUrl !== undefined) feed.siteUrl = siteUrl;
  return feed;
}

// ---------------------------------------------------------------------------------------------
// Public functions

/** Cuts a broken XML feed after its last complete entry and closes the open elements. */
function repairCutFeed(source: string): string | null {
  const item = source.lastIndexOf("</item>");
  const entry = source.lastIndexOf("</entry>");
  if (item < 0 && entry < 0) return null;
  if (entry > item) return `${source.slice(0, entry + "</entry>".length)}</feed>`;
  const head = source.slice(0, item + "</item>".length);
  return /<rss[\s>]/i.test(source.slice(0, 2000)) ? `${head}</channel></rss>` : `${head}</rdf:RDF>`;
}

/**
 * Parses an RSS 2.0, RSS 1.0, Atom, or JSON Feed document. Entries come back in feed order.
 * Relative links are resolved against `xml:base`, the feed link, or `baseUrl`.
 * Throws `NotAFeedError` ("This address did not return a feed") for any other document.
 */
export function parseFeed(xml: string, baseUrl?: string): ParsedFeed {
  if (typeof xml !== "string") throw new NotAFeedError();
  const source = xml.replace(/^[﻿\s]+/, "");
  if (source === "") throw new NotAFeedError();
  const base = baseUrl !== undefined && /^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : undefined;
  if (source.startsWith("{")) return parseJsonFeed(source, base);
  if (!source.startsWith("<")) throw new NotAFeedError();

  let root: ReturnType<typeof parseXml>;
  try {
    root = parseXml(source);
  } catch {
    // A document that was cut off: keep the entries that are complete.
    const repaired = repairCutFeed(source);
    if (repaired === null) throw new NotAFeedError();
    try {
      root = parseXml(repaired);
    } catch {
      throw new NotAFeedError();
    }
  }
  if (root === null) throw new NotAFeedError();
  if (root.name === "rss" || root.name === "rdf:rdf") return parseRss(root.node, root.name, base);
  if (root.name === "feed") return parseAtom(root.node, base);
  throw new NotAFeedError();
}

const FEED_TYPES = new Set([
  "application/rss+xml", "application/atom+xml", "application/feed+json",
  "application/x-rss+xml", "application/x.atom+xml", "application/x-atom+xml", "text/rss+xml", "text/atom+xml",
]);
/** Types that can be a feed or another thing: the link counts only when its title or address says "feed". */
const MAYBE_FEED_TYPES = new Set(["application/json", "application/xml", "text/xml", "application/rdf+xml"]);
const FEED_WORD = /feed|rss|atom/i;

/**
 * The feed addresses that a page announces with `<link rel="alternate">` (RSS, Atom, JSON Feed),
 * resolved against `baseUrl` (or the <base> element of the page), in page order, with no duplicates.
 */
export function discoverFeeds(html: string, baseUrl: string): string[] {
  if (typeof html !== "string" || html === "") return [];
  let base: string | undefined = /^https?:\/\//i.test((baseUrl ?? "").trim()) ? baseUrl.trim() : undefined;
  const baseTag = /<base\b([^>]*)>/i.exec(html);
  if (baseTag?.[1] !== undefined) base = resolveUrl(parseAttributes(baseTag[1])["href"], [base]) ?? base;

  const out: string[] = [];
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = parseAttributes(match[1] ?? "");
    const rel = (a["rel"] ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate") || rel.includes("stylesheet")) continue;
    const type = (a["type"] ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
    const href = (a["href"] ?? "").trim();
    if (href === "") continue;
    if (!FEED_TYPES.has(type)) {
      if (!MAYBE_FEED_TYPES.has(type)) continue;
      if (/\/wp-json\b|oembed/i.test(href) || !FEED_WORD.test(`${a["title"] ?? ""} ${href}`)) continue;
    }
    const url = resolveUrl(href, [base]);
    if (url !== undefined && !out.includes(url)) out.push(url);
  }
  return out;
}
