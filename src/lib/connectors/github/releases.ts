// Releases of a repository from the public Atom feed
// https://github.com/<owner>/<repo>/releases.atom (verified with keyless requests on 2026-11-20:
// 200 with the 10 newest releases, a weak ETag, 304 for If-None-Match; 404 for a missing repository).
import { z } from "zod";

import { NotAFeedError, parseFeed, type FeedEntry } from "@/lib/feeds";
import { extractLinks, stripInvisible, truncate } from "@/lib/text";

import type { GithubConfig } from "../configs";
import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type ConnectorContext, type RawItem } from "../types";
import { GITHUB_API_HEADERS, send, statusError } from "./http";

export interface GithubReleasesState {
  etag?: string;
  lastModified?: string;
  /** Entry ids of the feed that the source has seen, newest first (at most 200). */
  seenIds: string[];
}

const MAX_SEEN = 200;
const PRERELEASE_WORDS = new Set(["alpha", "beta", "rc", "pre", "preview", "nightly", "canary", "dev"]);

/**
 * True when a tag name looks like a prerelease: a word such as alpha, beta, rc, pre, preview,
 * nightly, canary, or dev ("v1.2.0-rc1", "nightly-2026-11-20", "2025-11-25-RC"), or a version with a
 * pre-release part ("0.171.0-alpha.13", "1.4.0-2", "2.0.0b1").
 */
export function isPrereleaseTag(tag: string): boolean {
  const text = tag.trim();
  if (text === "") return false;
  if (/\d+\.\d+(?:\.\d+)*-[0-9A-Za-z]/.test(text)) return true;
  if (/\d+\.\d+(?:\.\d+)*(?:a|b)\d+$/i.test(text)) return true;
  const words = text
    .replace(/([a-z])(\d)/gi, "$1 $2")
    .replace(/(\d)([a-z])/gi, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((word) => PRERELEASE_WORDS.has(word));
}

/** The tag of a feed entry: from the link ".../releases/tag/<tag>", else from the id ".../<tag>". */
export function tagOf(entry: FeedEntry): string {
  const link = entry.link ?? "";
  const match = /\/releases\/tag\/([^?#]+)/.exec(link);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  const id = /^tag:github\.com,\d+:Repository\/\d+\/(.+)$/.exec(entry.id);
  return id?.[1] ?? entry.title;
}

export function releasesFeedUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases.atom`;
}

/** Newest first; entries with no date keep their feed order after the dated ones. */
export function newestFirst<T extends { publishedAt?: number }>(list: T[]): T[] {
  return list
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (b.value.publishedAt ?? -Infinity) - (a.value.publishedAt ?? -Infinity) || a.index - b.index)
    .map(({ value }) => value);
}

const restReleaseSchema = z.object({
  tag_name: z.string(),
  prerelease: z.boolean().optional(),
  draft: z.boolean().optional(),
});

/**
 * The tags that the REST API marks as prerelease or draft (only with GITHUB_TOKEN). A failure gives
 * null: the tag pattern then decides alone.
 */
async function restPrereleaseTags(config: GithubConfig, ctx: ConnectorContext, token: string): Promise<Set<string> | null> {
  try {
    const res = await send(
      ctx,
      {
        url: `https://api.github.com/repos/${config.owner}/${config.repo}/releases?per_page=30`,
        headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` },
        timeoutMs: 15_000,
      },
      "GitHub releases API",
    );
    if (!res.ok) return null;
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(res.text));
    if (!parsed.success) return null;
    const tags = new Set<string>();
    for (const raw of parsed.data) {
      const release = restReleaseSchema.safeParse(raw);
      if (release.success && (release.data.prerelease === true || release.data.draft === true)) tags.add(release.data.tag_name);
    }
    return tags;
  } catch {
    return null;
  }
}

function releaseItem(entry: FeedEntry, config: GithubConfig, tag: string, prerelease: boolean): RawItem {
  const repoName = `${config.owner}/${config.repo}`;
  const rawTitle = entry.title.trim() || tag;
  const title = rawTitle.toLowerCase().includes(config.repo.toLowerCase()) ? rawTitle : `${config.repo} ${rawTitle}`;
  const text = stripInvisible(entry.text).trim() || `Release ${tag} of ${repoName}.`;
  const links = extractLinks(entry.html ?? entry.text, entry.link).slice(0, RAW_ITEM_MAX_LINKS);
  const item: RawItem = {
    externalId: entry.id,
    title: truncate(title, 300),
    kind: "release",
    text: truncate(text, RAW_ITEM_MAX_TEXT),
    meta: { event: "release", repo: repoName, tag, prerelease },
  };
  if (entry.link) item.url = entry.link;
  if (entry.author) item.author = entry.author;
  if (entry.publishedAt !== undefined) item.publishedAt = entry.publishedAt;
  if (links.length > 0) item.links = links;
  return item;
}

export async function fetchReleases(args: {
  config: GithubConfig;
  state: GithubReleasesState | undefined;
  conditional: boolean;
  ctx: ConnectorContext;
}): Promise<{ items: RawItem[]; state: GithubReleasesState }> {
  const { config, state, conditional, ctx } = args;
  const url = releasesFeedUrl(config.owner, config.repo);
  const res = await send(
    ctx,
    {
      url,
      headers: { Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
      ...(conditional && state?.etag ? { etag: state.etag } : {}),
      ...(conditional && state?.lastModified ? { lastModified: state.lastModified } : {}),
    },
    "the GitHub releases feed",
  );
  if (res.notModified || res.status === 304) {
    return { items: [], state: state ?? { seenIds: [] } };
  }
  if (!res.ok) {
    throw statusError(res, ctx.now(), "releases feed", `The repository ${config.owner}/${config.repo} was not found on GitHub.`);
  }
  let entries: FeedEntry[];
  try {
    entries = parseFeed(res.text, url).entries;
  } catch (error) {
    if (error instanceof NotAFeedError) {
      throw new ConnectorError("bad_response", `GitHub did not return the releases feed of ${config.owner}/${config.repo}.`);
    }
    throw error;
  }
  entries = newestFirst(entries.filter((entry) => entry.id !== ""));

  const seen = new Set(conditional ? (state?.seenIds ?? []) : []);
  const fresh = entries.filter((entry) => !seen.has(entry.id));

  let restTags: Set<string> | null = null;
  const token = ctx.env.githubToken;
  if (!config.prereleases && token && fresh.length > 0) restTags = await restPrereleaseTags(config, ctx, token);

  const items: RawItem[] = [];
  for (const entry of fresh) {
    const tag = tagOf(entry);
    const prerelease = isPrereleaseTag(tag) || (restTags?.has(tag) ?? false);
    if (prerelease && !config.prereleases) continue;
    items.push(releaseItem(entry, config, tag, prerelease));
  }

  const ids = entries.map((entry) => entry.id);
  const kept = (state?.seenIds ?? []).filter((id) => !ids.includes(id));
  const next: GithubReleasesState = { seenIds: [...ids, ...kept].slice(0, MAX_SEEN) };
  if (res.etag) next.etag = res.etag;
  if (res.lastModified) next.lastModified = res.lastModified;
  return { items, state: next };
}
