// Discussions of a repository through the GraphQL API (POST https://api.github.com/graphql). The API
// needs a token, so this runs only with GITHUB_TOKEN. Written from the official documentation
// (docs.github.com/graphql: Repository.discussions with orderBy CREATED_AT DESC, Discussion fields,
// the `errors` array with `type` NOT_FOUND / RATE_LIMITED); no live request proved it.
import { z } from "zod";

import { extractLinks, stripInvisible, truncate } from "@/lib/text";

import type { GithubConfig } from "../configs";
import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type ConnectorContext, type RawItem } from "../types";
import { send, statusError } from "./http";

export interface GithubDiscussionsState {
  /** Node ids of the discussions that the source has seen, newest first (at most 300). */
  seenIds: string[];
}

const MAX_SEEN = 300;
export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

export const DISCUSSIONS_QUERY = `query RecentDiscussions($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    hasDiscussionsEnabled
    discussions(first: $first, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        id
        number
        title
        url
        createdAt
        bodyText
        author { login }
        category { name slug }
        comments { totalCount }
        upvoteCount
      }
    }
  }
}`;

const discussionSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().optional(),
  title: z.string(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
  bodyText: z.string().nullable().optional(),
  author: z.object({ login: z.string() }).nullable().optional(),
  category: z.object({ name: z.string(), slug: z.string().optional() }).nullable().optional(),
  comments: z.object({ totalCount: z.number() }).nullable().optional(),
  upvoteCount: z.number().optional(),
});
type Discussion = z.infer<typeof discussionSchema>;

const responseSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          hasDiscussionsEnabled: z.boolean().optional(),
          discussions: z.object({ nodes: z.array(z.unknown()).nullable() }).nullable().optional(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string().optional() })).optional(),
});

function matchesCategory(d: Discussion, categories: string[]): boolean {
  if (categories.length === 0) return true;
  const name = (d.category?.name ?? "").trim().toLowerCase();
  const slug = (d.category?.slug ?? "").trim().toLowerCase();
  return categories.some((c) => {
    const wanted = c.trim().toLowerCase();
    return wanted !== "" && (wanted === name || wanted === slug);
  });
}

function discussionItem(d: Discussion, config: GithubConfig): RawItem {
  const repoName = `${config.owner}/${config.repo}`;
  const body = stripInvisible(d.bodyText ?? "").trim();
  const item: RawItem = {
    externalId: `discussion:${d.id}`,
    title: truncate(d.title.trim() || `Discussion #${d.number ?? "?"} in ${repoName}`, 300),
    kind: "discussion",
    text: truncate(body, RAW_ITEM_MAX_TEXT),
    meta: {
      event: "discussion",
      repo: repoName,
      number: d.number ?? null,
      category: d.category?.name ?? null,
      comments: d.comments?.totalCount ?? 0,
      upvotes: d.upvoteCount ?? 0,
    },
  };
  if (d.url && /^https:\/\//.test(d.url)) item.url = d.url;
  if (d.author?.login) item.author = d.author.login;
  const created = d.createdAt ? Date.parse(d.createdAt) : NaN;
  if (Number.isFinite(created)) item.publishedAt = created;
  const links = extractLinks(body).slice(0, RAW_ITEM_MAX_LINKS);
  if (links.length > 0) item.links = links;
  return item;
}

export async function fetchDiscussions(args: {
  config: GithubConfig;
  state: GithubDiscussionsState | undefined;
  conditional: boolean;
  first: number;
  token: string;
  ctx: ConnectorContext;
}): Promise<{ items: RawItem[]; state: GithubDiscussionsState }> {
  const { config, state, conditional, token, ctx } = args;
  const first = Math.max(1, Math.min(100, config.discussionCategories.length > 0 ? 50 : args.first));
  const res = await send(
    ctx,
    {
      url: GITHUB_GRAPHQL_URL,
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: DISCUSSIONS_QUERY, variables: { owner: config.owner, name: config.repo, first } }),
    },
    "the GitHub GraphQL API",
  );
  if (!res.ok) {
    throw statusError(res, ctx.now(), "discussions", `The repository ${config.owner}/${config.repo} was not found on GitHub.`);
  }
  let body: z.infer<typeof responseSchema>;
  try {
    body = responseSchema.parse(JSON.parse(res.text));
  } catch {
    throw new ConnectorError("bad_response", "GitHub sent discussions in a form that the app cannot read.");
  }
  const errors = body.errors ?? [];
  if (errors.some((e) => e.type === "RATE_LIMITED")) {
    throw new ConnectorError("rate_limited", "GitHub limits the requests of this token (discussions). The next check tries again.");
  }
  const repository = body.data?.repository ?? null;
  if (repository === null) {
    if (errors.length === 0 || errors.some((e) => e.type === "NOT_FOUND")) {
      throw new ConnectorError("not_found", `The repository ${config.owner}/${config.repo} was not found on GitHub.`);
    }
    throw new ConnectorError("bad_response", `GitHub refused the discussions query: ${truncate(errors[0]?.message ?? "unknown error", 200)}`);
  }
  if (repository.hasDiscussionsEnabled === false) return { items: [], state: state ?? { seenIds: [] } };

  const discussions: Discussion[] = [];
  for (const raw of repository.discussions?.nodes ?? []) {
    const parsed = discussionSchema.safeParse(raw);
    if (parsed.success) discussions.push(parsed.data);
  }
  const seen = new Set(conditional ? (state?.seenIds ?? []) : []);
  const items = discussions
    .filter((d) => !seen.has(d.id) && matchesCategory(d, config.discussionCategories))
    .map((d) => discussionItem(d, config))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const ids = discussions.map((d) => d.id);
  const kept = (state?.seenIds ?? []).filter((id) => !ids.includes(id));
  return { items, state: { seenIds: [...ids, ...kept].slice(0, MAX_SEEN) } };
}
