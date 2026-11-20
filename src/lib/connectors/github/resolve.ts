// Turns a repository link or "owner/repo" text into a github candidate. One request to the releases
// feed checks that the repository exists and gives its exact name and its latest release.
import { z } from "zod";

import { NotAFeedError, parseFeed } from "@/lib/feeds";
import { HttpError } from "@/lib/http/types";
import { truncate } from "@/lib/text";

import { githubConfigSchema, type GithubConfig } from "../configs";
import type { Candidate, ConnectorContext } from "../types";
import { GITHUB_API_HEADERS } from "./http";
import { isPrereleaseTag, newestFirst, releasesFeedUrl, tagOf } from "./releases";

export const DISCUSSIONS_NEED_TOKEN = "Discussions need GITHUB_TOKEN";

export interface RepoRef {
  owner: string;
  repo: string;
  /** The part of the repository that the link pointed at. */
  focus: "releases" | "discussions" | "advisories" | null;
  /** True for a link to github.com; false for "owner/repo" text. */
  fromLink: boolean;
}

/** First path segments of github.com that are not a user or an organization. */
const RESERVED_OWNERS = new Set([
  "about", "account", "apps", "blog", "codespaces", "collections", "contact", "customer-stories", "dashboard",
  "enterprise", "events", "explore", "features", "gist", "issues", "login", "logout", "marketplace", "new",
  "notifications", "orgs", "organizations", "pricing", "pulls", "readme", "search", "security", "settings",
  "site", "sponsors", "team", "topics", "trending", "users",
]);

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function cleanRepo(repo: string): string {
  return repo.replace(/\.git$/i, "");
}

function valid(owner: string, repo: string): boolean {
  return OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== ".." && !RESERVED_OWNERS.has(owner.toLowerCase());
}

/** Reads a repository from a github.com link, a git address, or "owner/repo" text. */
export function parseRepoInput(input: string): RepoRef | null {
  const text = input.trim().replace(/^<|>$/g, "").replace(/[.,;)]+$/, "");
  if (text === "" || /\s/.test(text)) return null;

  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);
  if (ssh?.[1] && ssh[2]) {
    return valid(ssh[1], ssh[2]) ? { owner: ssh[1], repo: ssh[2], focus: null, fromLink: true } : null;
  }

  if (/^(?:(?:https?|git):\/\/)?(?:www\.)?(?:github\.com|api\.github\.com\/repos)\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(text) ? text.replace(/^git:/i, "https:") : `https://${text}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    let parts = url.pathname.split("/").filter((part) => part !== "");
    if (host === "api.github.com") {
      if (parts[0] !== "repos") return null;
      parts = parts.slice(1);
    } else if (host !== "github.com" && host !== "www.github.com") {
      return null;
    }
    const [owner, rawRepo, section, sub] = parts;
    if (!owner || !rawRepo) return null;
    const repo = cleanRepo(rawRepo);
    if (!valid(owner, repo)) return null;
    let focus: RepoRef["focus"] = null;
    if (section === "releases" || section === "tags") focus = "releases";
    else if (section === "discussions") focus = "discussions";
    else if (section === "security" && (sub === undefined || sub === "advisories")) focus = "advisories";
    return { owner, repo, focus, fromLink: true };
  }

  const plain = /^@?([^/\s]+)\/([^/\s]+?)\/?$/.exec(text);
  if (plain?.[1] && plain[2]) {
    const repo = cleanRepo(plain[2]);
    return valid(plain[1], repo) ? { owner: plain[1], repo, focus: null, fromLink: false } : null;
  }
  return null;
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function configFor(owner: string, repo: string, focus: RepoRef["focus"]): GithubConfig {
  return githubConfigSchema.parse({
    owner,
    repo,
    discussions: focus === "discussions",
    advisories: focus === "advisories",
  });
}

function warningsFor(ctx: ConnectorContext, extra: string[] = []): string[] | undefined {
  const warnings = [...extra];
  if (!ctx.env.has("GITHUB_TOKEN")) warnings.push(DISCUSSIONS_NEED_TOKEN);
  return warnings.length > 0 ? warnings : undefined;
}

/** The exact owner and repository name from a github.com address, or null. */
function namesFromUrl(address: string | undefined): { owner: string; repo: string } | null {
  if (!address) return null;
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(address);
  if (!match?.[1] || !match[2]) return null;
  const repo = cleanRepo(match[2].replace(/\.atom$/i, ""));
  return valid(match[1], repo) ? { owner: match[1], repo } : null;
}

async function checkRepository(ref: RepoRef, ctx: ConnectorContext, confidence: number): Promise<Candidate[]> {
  const url = releasesFeedUrl(ref.owner, ref.repo);
  let status: number;
  let text = "";
  let finalUrl = url;
  try {
    const res = await ctx.http.request({
      url,
      headers: { Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
      timeoutMs: 10_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    status = res.status;
    text = res.text;
    finalUrl = res.url || url;
  } catch (error) {
    if (error instanceof HttpError && (error.kind === "bad_url" || error.kind === "blocked_address")) return [];
    status = 0;
  }
  if (status === 404 || status === 410 || status === 451) return [];

  const owner = ref.owner;
  const repo = ref.repo;
  if (status < 200 || status >= 300) {
    // GitHub did not answer now: offer the candidate without the check.
    return [
      {
        type: "github",
        name: `${owner}/${repo}`,
        description: "GitHub repository: releases, and optionally discussions and security advisories.",
        url: `https://github.com/${owner}/${repo}`,
        config: configFor(owner, repo, ref.focus),
        confidence: Math.max(0.2, confidence - 0.35),
        warnings: warningsFor(ctx, ["GitHub did not answer now, so the app could not check that this repository exists."]),
      },
    ];
  }

  let names = namesFromUrl(finalUrl) ?? { owner, repo };
  let description = "GitHub repository. No releases yet.";
  try {
    const feed = parseFeed(text, finalUrl);
    names = namesFromUrl(feed.siteUrl) ?? names;
    const entries = newestFirst(feed.entries);
    const latest = entries.find((entry) => !isPrereleaseTag(tagOf(entry))) ?? entries[0];
    if (latest) {
      const when = latest.publishedAt !== undefined ? ` (${formatDay(latest.publishedAt)})` : "";
      description = `GitHub repository. Latest release: ${truncate(latest.title.trim() || "untitled", 80)}${when}.`;
    }
  } catch (error) {
    if (!(error instanceof NotAFeedError)) throw error;
    description = "GitHub repository.";
  }
  return [
    {
      type: "github",
      name: `${names.owner}/${names.repo}`,
      description,
      url: `https://github.com/${names.owner}/${names.repo}`,
      config: configFor(names.owner, names.repo, ref.focus),
      confidence,
      warnings: warningsFor(ctx),
    },
  ];
}

const searchSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      full_name: z.string(),
      description: z.string().nullable().optional(),
      html_url: z.string().optional(),
      stargazers_count: z.number().optional(),
      archived: z.boolean().optional(),
      owner: z.object({ login: z.string() }),
    }),
  ),
});

/** With the GitHub chip and plain text: the 3 best matches of the keyless repository search. */
async function searchRepositories(input: string, ctx: ConnectorContext): Promise<Candidate[]> {
  const query = input.trim().slice(0, 100);
  if (query.length < 2) return [];
  try {
    const res = await ctx.http.request({
      url: `https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} in:name,description`)}&per_page=3`,
      headers: GITHUB_API_HEADERS,
      timeoutMs: 10_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) return [];
    const parsed = searchSchema.safeParse(JSON.parse(res.text));
    if (!parsed.success) return [];
    const out: Candidate[] = [];
    parsed.data.items.slice(0, 3).forEach((hit, index) => {
      if (hit.archived) return;
      const owner = hit.owner.login;
      if (!valid(owner, hit.name)) return;
      const stars = hit.stargazers_count !== undefined ? ` ${hit.stargazers_count.toLocaleString("en-US")} stars.` : "";
      const about = hit.description ? ` ${truncate(hit.description.trim(), 140)}` : "";
      out.push({
        type: "github",
        name: `${owner}/${hit.name}`,
        description: `GitHub repository.${about}${stars}`.trim(),
        url: `https://github.com/${owner}/${hit.name}`,
        config: configFor(owner, hit.name, null),
        confidence: 0.4 - index * 0.05,
        warnings: warningsFor(ctx),
      });
    });
    return out;
  } catch {
    return [];
  }
}

export async function resolveGithub(input: string, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]> {
  const ref = parseRepoInput(input);
  if (ref === null) return forced ? searchRepositories(input, ctx) : [];
  // "r/name" and "u/name" are Reddit names, unless the person chose the GitHub type.
  if (!ref.fromLink && !forced && /^[ru]$/i.test(ref.owner)) return [];
  return checkRepository(ref, ctx, ref.fromLink ? 0.95 : forced ? 0.85 : 0.7);
}
