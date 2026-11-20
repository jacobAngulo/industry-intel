// Published security advisories of a repository from the REST API, with no token:
// GET https://api.github.com/repos/<owner>/<repo>/security-advisories?sort=published&direction=desc
// (verified with keyless requests on 2026-11-20: 200 with the published advisories, ETag and
// Last-Modified, 304 for If-None-Match (it still counts against the limit of 60 requests each hour
// without a token), 404 for a missing repository, and the x-ratelimit-* headers).
import { z } from "zod";

import { extractLinks, stripInvisible, truncate } from "@/lib/text";

import type { GithubConfig } from "../configs";
import { ConnectorError, RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type ConnectorContext, type RawItem } from "../types";
import { GITHUB_API_HEADERS, send, statusError } from "./http";

export interface GithubAdvisoriesState {
  etag?: string;
  lastModified?: string;
  /** GHSA ids that the source has seen, newest first (at most 200). */
  seenIds: string[];
}

const MAX_SEEN = 200;

const optionalText = z.string().nullable().optional();
const advisorySchema = z.object({
  ghsa_id: z.string().min(1),
  cve_id: optionalText,
  html_url: optionalText,
  summary: optionalText,
  description: optionalText,
  severity: optionalText,
  state: optionalText,
  published_at: optionalText,
  withdrawn_at: optionalText,
  vulnerabilities: z
    .array(
      z.object({
        package: z.object({ ecosystem: optionalText, name: optionalText }).nullable().optional(),
        vulnerable_version_range: optionalText,
        patched_versions: optionalText,
      }),
    )
    .nullable()
    .optional(),
  cvss_severities: z
    .object({
      cvss_v3: z.object({ score: z.number().nullable().optional() }).nullable().optional(),
      cvss_v4: z.object({ score: z.number().nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type GithubAdvisory = z.infer<typeof advisorySchema>;

export function advisoriesUrl(owner: string, repo: string, perPage: number): string {
  return `https://api.github.com/repos/${owner}/${repo}/security-advisories?per_page=${perPage}&sort=published&direction=desc`;
}

function advisoryItem(a: GithubAdvisory, config: GithubConfig): RawItem {
  const repoName = `${config.owner}/${config.repo}`;
  const summary = (a.summary ?? "").trim() || a.ghsa_id;
  const url = a.html_url && /^https:\/\//.test(a.html_url)
    ? a.html_url
    : `https://github.com/${config.owner}/${config.repo}/security/advisories/${a.ghsa_id}`;
  const score = a.cvss_severities?.cvss_v4?.score ?? a.cvss_severities?.cvss_v3?.score ?? null;
  const lines: string[] = [];
  if (a.severity) lines.push(`Severity: ${a.severity}${score !== null ? ` (CVSS ${score})` : ""}`);
  lines.push(`Advisory: ${a.ghsa_id}${a.cve_id ? ` (${a.cve_id})` : ""}`);
  for (const v of a.vulnerabilities ?? []) {
    const name = [v.package?.ecosystem, v.package?.name].filter(Boolean).join(" ");
    const range = v.vulnerable_version_range ? ` ${v.vulnerable_version_range}` : "";
    const patched = v.patched_versions ? `; patched: ${v.patched_versions}` : "";
    if (name || range) lines.push(`Affected: ${name}${range}${patched}`);
  }
  const description = stripInvisible(a.description ?? "").trim();
  const text = [lines.join("\n"), description].filter((part) => part !== "").join("\n\n");
  const links = [url, ...extractLinks(description).filter((link) => link !== url)].slice(0, RAW_ITEM_MAX_LINKS);
  const item: RawItem = {
    externalId: `advisory:${a.ghsa_id}`,
    url,
    title: truncate(`Security advisory for ${repoName}: ${summary}`, 300),
    kind: "advisory",
    text: truncate(text, RAW_ITEM_MAX_TEXT),
    links,
    meta: { event: "advisory", repo: repoName, ghsaId: a.ghsa_id, cveId: a.cve_id ?? null, severity: a.severity ?? null },
  };
  const published = a.published_at ? Date.parse(a.published_at) : NaN;
  if (Number.isFinite(published)) item.publishedAt = published;
  return item;
}

export async function fetchAdvisories(args: {
  config: GithubConfig;
  state: GithubAdvisoriesState | undefined;
  conditional: boolean;
  perPage: number;
  ctx: ConnectorContext;
}): Promise<{ items: RawItem[]; state: GithubAdvisoriesState }> {
  const { config, state, conditional, perPage, ctx } = args;
  const res = await send(
    ctx,
    {
      url: advisoriesUrl(config.owner, config.repo, perPage),
      headers: GITHUB_API_HEADERS,
      ...(conditional && state?.etag ? { etag: state.etag } : {}),
      ...(conditional && state?.lastModified ? { lastModified: state.lastModified } : {}),
    },
    "the GitHub security advisories API",
  );
  if (res.notModified || res.status === 304) return { items: [], state: state ?? { seenIds: [] } };
  if (!res.ok) {
    throw statusError(
      res,
      ctx.now(),
      "security advisories",
      `The repository ${config.owner}/${config.repo} was not found on GitHub, or its security advisories are not public.`,
    );
  }
  let list: unknown[];
  try {
    list = z.array(z.unknown()).parse(JSON.parse(res.text));
  } catch {
    throw new ConnectorError("bad_response", "GitHub sent security advisories in a form that the app cannot read.");
  }
  const advisories: GithubAdvisory[] = [];
  for (const raw of list) {
    const parsed = advisorySchema.safeParse(raw);
    if (!parsed.success) continue;
    const a = parsed.data;
    if (a.withdrawn_at || (a.state && a.state !== "published")) continue;
    advisories.push(a);
  }

  const seen = new Set(conditional ? (state?.seenIds ?? []) : []);
  const items = advisories
    .filter((a) => !seen.has(a.ghsa_id))
    .map((a) => advisoryItem(a, config))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const ids = advisories.map((a) => a.ghsa_id);
  const kept = (state?.seenIds ?? []).filter((id) => !ids.includes(id));
  const next: GithubAdvisoriesState = { seenIds: [...ids, ...kept].slice(0, MAX_SEEN) };
  if (res.etag) next.etag = res.etag;
  if (res.lastModified) next.lastModified = res.lastModified;
  return { items, state: next };
}
