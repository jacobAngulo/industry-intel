// The `research` connector (specification §6.3): new papers for a topic or an
// author (the arXiv API, one request each 3 s), or for a lab (OpenAlex works
// of an institution).
import { z } from "zod";

import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, sourceKey, researchConfigSchema, type ResearchConfig } from "../configs";
import type { Candidate, Connector, ConnectorContext, RawItem } from "../types";
import { parseInputUrl, previewCount, selectNew } from "../community/shared";
import { ALL_PAPERS, arxivGet, arxivSearch, arxivSearchQuery, authorNameFromPage } from "./arxiv";
import { fetchOpenAlexWorks, institutionIdOf, lookupInstitution, searchInstitutions } from "./openalex";

/**
 * The cursor of a research source: the external ids that the source returned
 * before (newest first, at most 500). arXiv and OpenAlex send no ETag or
 * Last-Modified (checked on 2026-11-20), so there is no conditional GET.
 */
export interface ResearchCursor {
  variant: ResearchConfig["variant"];
  seenIds: string[];
}

export const researchCursorSchema = z.object({
  variant: z.enum(["arxiv_query", "arxiv_author", "openalex_institution"]),
  seenIds: z.array(z.string()).max(5000),
});

function readCursor(cursor: unknown, variant: ResearchConfig["variant"]): ResearchCursor | null {
  const parsed = researchCursorSchema.safeParse(cursor);
  return parsed.success && parsed.data.variant === variant ? parsed.data : null;
}

// --- candidates -------------------------------------------------------------------

const CATEGORY = /^[A-Za-z-]+(?:\.[A-Za-z-]+)?$/;

function queryCandidate(query: string, categories: string[], confidence: number, warnings: string[] = []): Candidate {
  const config: ResearchConfig = { variant: "arxiv_query", query: query.slice(0, 300), categories };
  const all = query === ALL_PAPERS;
  const cats = categories.join(", ");
  return {
    type: "research",
    name: (all ? `arXiv ${cats}: all new papers` : `arXiv: "${query}"${cats ? ` in ${cats}` : ""}`).slice(0, 120),
    description: all
      ? `Every new arXiv paper in ${cats}.`
      : `New arXiv papers that match "${query}"${cats ? ` in ${cats}` : ""}, newest first.`,
    url: all
      ? `https://arxiv.org/list/${categories[0]}/recent`
      : `https://arxiv.org/search/?query=${encodeURIComponent(query)}&searchtype=all&order=-announced_date_first`,
    config,
    confidence,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function authorCandidate(author: string, confidence: number, warnings: string[] = []): Candidate {
  const name = author.trim().slice(0, 120);
  return {
    type: "research",
    name: `arXiv: ${name}`.slice(0, 120),
    description: `New arXiv papers by ${name}.`,
    url: `https://arxiv.org/search/?query=${encodeURIComponent(name)}&searchtype=author&order=-announced_date_first`,
    config: { variant: "arxiv_author", author: name } satisfies ResearchConfig,
    confidence,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

const ALL_WARNING = (cat: string) =>
  `This follows every new paper in ${cat}. A busy category has hundreds each day: add words to the query to narrow it.`;

async function resolveArxivUrl(url: URL, ctx: ConnectorContext): Promise<Candidate[]> {
  const parts = url.pathname.split("/").filter(Boolean);
  const head = parts[0]?.toLowerCase();
  if (head === "list" && parts[1] && CATEGORY.test(parts[1])) {
    return [queryCandidate(ALL_PAPERS, [parts[1]], 0.9, [ALL_WARNING(parts[1])])];
  }
  if (head === "a" && parts[1]) {
    const id = parts[1].replace(/\.(html|atom2?|json)$/i, "");
    if (!/^[a-z0-9_.-]{2,80}$/i.test(id)) return [];
    try {
      const res = await arxivGet(ctx, `https://arxiv.org/a/${encodeURIComponent(id)}`, "text/html");
      const name = res.ok ? authorNameFromPage(res.text) : null;
      if (name) return [authorCandidate(name, 0.9)];
    } catch {
      // Fall through to the guess.
    }
    const surname = id.split("_")[0] ?? id;
    const guess = surname.charAt(0).toUpperCase() + surname.slice(1);
    return [authorCandidate(guess, 0.4, ["The arXiv author page did not answer. The name is a guess from the link: check it."])];
  }
  if (head === "search") {
    const query = (url.searchParams.get("query") ?? "").trim();
    if (!query) return [];
    const searchtype = (url.searchParams.get("searchtype") ?? "all").toLowerCase();
    if (searchtype === "author") return [authorCandidate(query, 0.9)];
    return [queryCandidate(query, [], 0.9)];
  }
  return [];
}

/** Plain text that can be a topic: not a link, not an address, not an @handle. */
function isTopicText(text: string): boolean {
  if (text.length < 2 || text.length > 300) return false;
  if (/^@\S+$/.test(text)) return false;
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

const PERSON_NAME = /^\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*){1,3}$/u;

export const connector: Connector<ResearchConfig, ResearchCursor> = {
  type: "research",
  label: SOURCE_TYPE_LABELS.research,
  description: "New papers for a topic, an author, or a lab (arXiv, OpenAlex).",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.research.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.research.maxAgeDays,
  configSchema: researchConfigSchema,
  needs: (env, config) => credentialNeeds("research", env, config),
  keyOf: (config) => sourceKey("research", config),

  async resolve(input, ctx, forced): Promise<Candidate[]> {
    const text = typeof input === "string" ? input.trim() : "";
    if (text === "") return [];

    // Prefixes.
    const prefix = /^(arxiv|papers?|author|au|lab|institution|openalex)\s*:\s*(.*)$/i.exec(text);
    if (prefix && prefix[1] && prefix[2] !== undefined) {
      const kind = prefix[1].toLowerCase();
      const rest = prefix[2].trim().replace(/^["']|["']$/g, "").trim();
      if (rest === "") return [];
      if (kind === "author" || kind === "au") return [authorCandidate(rest, 0.9)];
      if (kind === "lab" || kind === "institution" || kind === "openalex") {
        const id = institutionIdOf(rest);
        return id ? lookupInstitution(ctx, id) : searchInstitutions(ctx, rest);
      }
      return [queryCandidate(rest, [], 0.9)];
    }

    const url = parseInputUrl(text);
    if (url) {
      const host = url.hostname.toLowerCase();
      if (host === "arxiv.org" || host === "www.arxiv.org" || host === "export.arxiv.org") return resolveArxivUrl(url, ctx);
      if (host === "openalex.org" || host === "www.openalex.org" || host === "api.openalex.org") {
        const id = institutionIdOf(url.pathname.replace(/\/+$/, ""));
        return id ? lookupInstitution(ctx, id) : [];
      }
      return [];
    }

    if (!isTopicText(text)) return [];
    if (!forced) return [queryCandidate(text, [], 0.3)];
    const candidates: Candidate[] = [queryCandidate(text, [], 0.7)];
    if (PERSON_NAME.test(text)) candidates.push(authorCandidate(text, 0.4));
    candidates.push(...(await searchInstitutions(ctx, text)));
    return candidates;
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const count = mode === "preview" ? previewCount(limit) : Math.min(100, Math.max(30, limit));
    let all: RawItem[];
    if (config.variant === "openalex_institution") {
      all = await fetchOpenAlexWorks(ctx, config, count);
    } else {
      all = await arxivSearch(ctx, arxivSearchQuery(config), count);
    }
    if (mode === "preview") return { items: selectNew(all, null, previewCount(limit)).items, cursor: null };
    const previous = readCursor(cursor, config.variant);
    const picked = selectNew(all, previous?.seenIds ?? null, limit);
    return { items: picked.items, cursor: { variant: config.variant, seenIds: picked.seenIds } };
  },
};
