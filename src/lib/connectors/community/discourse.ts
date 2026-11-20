// Discourse forums (specification §6.3): the `.json` endpoints `/latest.json`,
// `/c/<slug>/<id>.json`, and `/tag/<tag>.json`, each with `?order=created`
// so that the newest topics come first. The first post of a new topic comes
// from `/t/<id>.json` (a few topics for each poll).
//
// Checked live on 2026-11-20 on https://community.openai.com and
// https://discuss.huggingface.co: the pages carry
// `<meta name="generator" content="Discourse …">`; `/c/<id>.json` redirects to
// `/c/<parent>/<child>/<id>.json`; a tag that does not exist answers 404; the
// `tags` of a topic are objects `{ id, name, slug }` on one forum and `null`
// on the other (older versions send strings); no ETag / Last-Modified.
import { z } from "zod";

import { extractLinks, htmlToText } from "@/lib/text";

import type { CommunityConfig } from "../configs";
import { ConnectorError, type Candidate, type ConnectorContext, type FetchResult, type RawItem } from "../types";
import {
  checkStatus,
  hostOf,
  isoTime,
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

export type DiscourseConfig = Extract<CommunityConfig, { variant: "discourse" }>;

/** The most first posts that one poll reads (one request each). */
export const DISCOURSE_BODY_FETCHES_POLL = 8;
/** The most first posts that one preview reads. */
export const DISCOURSE_BODY_FETCHES_PREVIEW = 3;

/** The base URL with no "/" at the end. */
export function discourseBase(baseUrl: string): string {
  return baseUrl.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function slugPath(slug: string): string {
  return slug
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** The list endpoint of a config. */
export function discourseListUrl(config: DiscourseConfig): string {
  const base = discourseBase(config.baseUrl);
  if (config.tag) return `${base}/tag/${encodeURIComponent(config.tag)}.json?order=created`;
  if (config.categorySlug && config.categoryId) return `${base}/c/${slugPath(config.categorySlug)}/${config.categoryId}.json?order=created`;
  if (config.categoryId) return `${base}/c/${config.categoryId}.json?order=created`;
  if (config.categorySlug) return `${base}/c/${slugPath(config.categorySlug)}.json?order=created`;
  return `${base}/latest.json?order=created`;
}

const topicSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().nullish(),
    fancy_title: z.string().nullish(),
    slug: z.string().nullish(),
    created_at: z.string().nullish(),
    posts_count: z.number().nullish(),
    reply_count: z.number().nullish(),
    like_count: z.number().nullish(),
    views: z.number().nullish(),
    category_id: z.number().nullish(),
    excerpt: z.string().nullish(),
    visible: z.boolean().nullish(),
    archetype: z.string().nullish(),
    tags: z.array(z.union([z.string(), z.object({ name: z.string() }).passthrough()])).nullish(),
    posters: z
      .array(z.object({ user_id: z.number().nullish(), description: z.string().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();
type Topic = z.infer<typeof topicSchema>;

const listSchema = z
  .object({
    users: z.array(z.object({ id: z.number(), username: z.string().nullish() }).passthrough()).nullish(),
    topic_list: z.object({ topics: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough();

const topicDetailSchema = z
  .object({
    post_stream: z
      .object({
        posts: z.array(z.object({ post_number: z.number().nullish(), cooked: z.string().nullish(), username: z.string().nullish() }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();

function originalPoster(topic: Topic, users: Map<number, string>): string | undefined {
  const posters = topic.posters ?? [];
  const op = posters.find((p) => (p.description ?? "").includes("Original Poster")) ?? posters[0];
  return op?.user_id != null ? users.get(op.user_id) : undefined;
}

/** One topic of a list to a RawItem (text = the title and the excerpt; the first post comes later). */
export function discourseTopicToItem(topic: Topic, base: string, users: Map<number, string>): RawItem | null {
  const title = str(topic.title) ?? str(topic.fancy_title);
  if (!title) return null;
  const url = `${base}/t/${encodeURIComponent(topic.slug || "topic")}/${topic.id}`;
  const excerpt = topic.excerpt ? htmlToText(topic.excerpt) : "";
  const publishedAt = isoTime(topic.created_at);
  const author = originalPoster(topic, users);
  const tags = (topic.tags ?? []).map((tag) => (typeof tag === "string" ? tag : tag.name)).filter(Boolean);
  return {
    externalId: String(topic.id),
    url,
    title,
    ...(author ? { author } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    kind: "discussion",
    text: itemText(excerpt ? `${title}\n\n${excerpt}` : title),
    links: itemLinks([url]),
    meta: {
      site: "discourse",
      forum: hostOf(base),
      replies: num(topic.reply_count) ?? Math.max(0, (num(topic.posts_count) ?? 1) - 1),
      likes: num(topic.like_count) ?? 0,
      views: num(topic.views) ?? 0,
      ...(topic.category_id != null ? { categoryId: topic.category_id } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
  };
}

/** Reads the first post of a topic and puts its text and links into the item. A failure keeps the item as it is. */
async function addFirstPost(item: RawItem, base: string, ctx: ConnectorContext): Promise<RawItem> {
  try {
    const res = await ctx.http.request({
      url: `${base}/t/${item.externalId}.json`,
      headers: { Accept: "application/json" },
      timeoutMs: 10_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) return item;
    const body = topicDetailSchema.safeParse(JSON.parse(res.text));
    if (!body.success) return item;
    const first = body.data.post_stream.posts.find((p) => p.post_number === 1) ?? body.data.post_stream.posts[0];
    const cooked = first?.cooked ?? "";
    if (!cooked) return item;
    const text = htmlToText(cooked);
    return {
      ...item,
      ...(item.author === undefined && first?.username ? { author: first.username } : {}),
      text: itemText(text ? `${item.title}\n\n${text}` : item.title),
      links: itemLinks([item.url, ...extractLinks(cooked, `${base}/`)]),
    };
  } catch {
    return item;
  }
}

export async function fetchDiscourse(args: {
  config: DiscourseConfig;
  cursor: unknown;
  mode: "preview" | "poll";
  limit: number;
  ctx: ConnectorContext;
}): Promise<FetchResult<CommunityCursor>> {
  const { config, mode, limit, ctx } = args;
  const cursor = mode === "poll" ? readCursor(args.cursor, "discourse") : null;
  const base = discourseBase(config.baseUrl);
  const what = `The forum ${hostOf(base)}`;
  const res = await send(
    ctx,
    {
      url: discourseListUrl(config),
      headers: { Accept: "application/json" },
      ...(cursor?.etag ? { etag: cursor.etag } : {}),
      ...(cursor?.lastModified ? { lastModified: cursor.lastModified } : {}),
    },
    what,
  );
  if (res.notModified && cursor) return { items: [], cursor };
  if (res.status === 403 || res.status === 401) {
    throw new ConnectorError("blocked", `${what} needs a login for this list (status ${res.status}). The app reads only public forums.`);
  }
  const target = config.tag ? `the tag "${config.tag}"` : config.categorySlug || config.categoryId ? "this category" : "this list";
  checkStatus(res, what, `${what} has no ${target} (404).`);
  if (!/^\s*\{/.test(res.text)) throw new ConnectorError("bad_response", `${what} did not send JSON. Is it a Discourse forum?`);
  const body = listSchema.safeParse(parseJson(res.text, what));
  if (!body.success) throw new ConnectorError("bad_response", `${what} sent no list of topics. Is it a Discourse forum?`);

  const users = new Map<number, string>();
  for (const user of body.data.users ?? []) if (user.username) users.set(user.id, user.username);

  const items: RawItem[] = [];
  for (const raw of body.data.topic_list.topics) {
    const topic = topicSchema.safeParse(raw);
    if (!topic.success) continue;
    if (topic.data.visible === false) continue;
    if (topic.data.archetype && topic.data.archetype !== "regular") continue;
    // A tag list inside a category: keep the topics of the category.
    if (config.tag && config.categoryId && topic.data.category_id != null && topic.data.category_id !== config.categoryId) continue;
    const item = discourseTopicToItem(topic.data, base, users);
    if (item) items.push(item);
  }

  const picked =
    mode === "preview"
      ? { items: selectNew(items, null, previewCount(limit)).items, seenIds: [] as string[] }
      : selectNew(items, cursor?.seenIds ?? null, limit);

  // The first post of the newest topics, one request each.
  const fetches = mode === "preview" ? DISCOURSE_BODY_FETCHES_PREVIEW : DISCOURSE_BODY_FETCHES_POLL;
  const out: RawItem[] = [];
  for (const [index, item] of picked.items.entries()) {
    out.push(index < fetches ? await addFirstPost(item, base, ctx) : item);
  }

  if (mode === "preview") return { items: out, cursor: null };
  return {
    items: out,
    cursor: {
      variant: "discourse",
      seenIds: picked.seenIds,
      ...(res.etag ? { etag: res.etag } : {}),
      ...(res.lastModified ? { lastModified: res.lastModified } : {}),
    },
  };
}

// --- resolve ------------------------------------------------------------------------

/** Path segments that end the base path of a forum. */
const ROUTE_SEGMENTS = new Set(["c", "t", "tag", "tags", "latest", "top", "new", "unread", "categories", "u", "g", "search", "hot", "posts"]);
const FORUM_HOST_LABELS = new Set(["community", "discuss", "discussion", "discussions", "forum", "forums", "discourse", "talk"]);

/** Parses a forum link: the base URL and the category or tag of the path. */
export function parseDiscoursePath(url: URL): {
  base: string;
  route: "root" | "category" | "tag" | "topic" | "other";
  categorySlug?: string;
  categoryId?: number;
  tag?: string;
} {
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decode(part).replace(/\.json$/i, ""));
  const index = parts.findIndex((part) => ROUTE_SEGMENTS.has(part.toLowerCase()));
  const baseParts = index < 0 ? parts : parts.slice(0, index);
  const base = `${url.origin}${baseParts.length > 0 ? `/${baseParts.map(encodeURIComponent).join("/")}` : ""}`;
  if (index < 0) return { base, route: "root" };
  const route = parts[index]!.toLowerCase();
  const rest = parts.slice(index + 1);
  if (route === "c") {
    const slugs: string[] = [];
    let id: number | undefined;
    for (const part of rest) {
      if (/^\d+$/.test(part)) {
        id = Number(part);
        break;
      }
      if (part === "l" || part === "none" || part === "all") break;
      slugs.push(part);
    }
    if (slugs.length === 0 && id === undefined) return { base, route: "root" };
    return {
      base,
      route: "category",
      ...(slugs.length > 0 ? { categorySlug: slugs.join("/") } : {}),
      ...(id !== undefined && id > 0 ? { categoryId: id } : {}),
    };
  }
  if (route === "tag" && rest[0]) return { base, route: "tag", tag: rest[0] };
  if (route === "t") return { base, route: "topic" };
  if (route === "latest" || route === "top" || route === "new" || route === "categories") return { base, route: "root" };
  return { base, route: "other" };
}

/** True when the link is worth one request to test for Discourse (forced, or it looks like a forum). */
export function looksLikeForum(url: URL, forced: boolean): boolean {
  if (forced) return true;
  const host = url.hostname.toLowerCase();
  const firstLabel = host.split(".")[0] ?? "";
  if (FORUM_HOST_LABELS.has(firstLabel)) return true;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.some((part) => part === "c" || part === "t" || part === "tag")) return true;
  return /^\/(forum|forums|community|discuss)(\/|$)/i.test(url.pathname);
}

function metaContent(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\s[^>]*(?:name|property)=["']${key}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  if (!tag) return undefined;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? htmlToText(content).trim() || undefined : undefined;
}

/** True when the HTML is a page of a Discourse forum. */
export function isDiscourseHtml(html: string): boolean {
  const generator = metaContent(html, "generator");
  if (generator && /^discourse\b/i.test(generator)) return true;
  return /<meta\s[^>]*name=["']discourse_theme_id/i.test(html) || /data-discourse-setup/i.test(html);
}

function humanize(slug: string): string {
  const last = slug.split("/").pop() ?? slug;
  const words = last.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

/** One request to the link; candidates when the page is a Discourse forum, else []. */
export async function resolveDiscourseUrl(url: URL, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]> {
  if (!looksLikeForum(url, forced)) return [];
  let html: string;
  let finalUrl: URL;
  try {
    const res = await ctx.http.request({
      url: url.href,
      headers: { Accept: "text/html" },
      timeoutMs: 8000,
      maxBytes: 1_500_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) return [];
    html = res.text;
    finalUrl = new URL(res.url || url.href);
  } catch {
    return [];
  }
  if (!isDiscourseHtml(html)) return [];

  const parsed = parseDiscoursePath(finalUrl);
  const site = metaContent(html, "og:site_name") ?? hostOf(parsed.base);
  const pageTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const titleText = pageTitle ? htmlToText(pageTitle).trim() : "";
  const latestMatch = /^Latest (.+?) topics\b/i.exec(titleText);

  let config: DiscourseConfig = { variant: "discourse", baseUrl: parsed.base };
  let name = site;
  let description = `New topics of the forum ${hostOf(parsed.base)}.`;
  let confidence = 0.9;
  const warnings: string[] = [];
  if (parsed.route === "category") {
    config = {
      ...config,
      ...(parsed.categorySlug ? { categorySlug: parsed.categorySlug } : {}),
      ...(parsed.categoryId ? { categoryId: parsed.categoryId } : {}),
    };
    const label = latestMatch?.[1] ?? (parsed.categorySlug ? humanize(parsed.categorySlug) : `category ${parsed.categoryId}`);
    name = `${site}: ${label}`;
    description = `New topics in the category "${label}" of ${hostOf(parsed.base)}.`;
  } else if (parsed.route === "tag" && parsed.tag) {
    config = { ...config, tag: parsed.tag };
    name = `${site}: #${parsed.tag}`;
    description = `New topics with the tag "${parsed.tag}" on ${hostOf(parsed.base)}.`;
  } else if (parsed.route === "topic" || parsed.route === "other") {
    confidence = 0.6;
    warnings.push("This link is one page of the forum. The candidate follows all new topics of the forum.");
  }
  return [
    {
      type: "community",
      name: name.slice(0, 120),
      description,
      url: finalUrl.href,
      config,
      confidence,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  ];
}
