// OpenAlex (https://api.openalex.org): the institution lookup for `resolve`
// and the newest works of an institution. No email address and no key in the
// request.
//
// Checked live on 2026-11-20: `/institutions?search=<name>&select=…` and
// `/institutions/<id>` answer 200; a missing institution answers 404 with
// `{ "error", "message" }`; `/works?filter=authorships.institutions.lineage:<id>,to_publication_date:<day>
// &sort=publication_date:desc&select=…` answers `results[]` with
// `abstract_inverted_index`; no ETag / Last-Modified. Requests with no key
// share a small free daily budget for each IP address (header
// x-ratelimit-limit-usd: 0.1; one works list costs $0.0001, one search $0.001).
import { z } from "zod";

import type { ResearchConfig } from "../configs";
import { ConnectorError, type Candidate, type ConnectorContext, type RawItem } from "../types";
import { checkStatus, itemLinks, itemText, num, parseJson, send, str } from "../community/shared";

export const OPENALEX_API = "https://api.openalex.org";
const WHAT = "OpenAlex";

export type OpenAlexConfig = Extract<ResearchConfig, { variant: "openalex_institution" }>;

const WORK_FIELDS = "id,doi,display_name,publication_date,authorships,abstract_inverted_index,primary_location,best_oa_location,ids,type";
const INSTITUTION_FIELDS = "id,display_name,country_code,type,works_count,homepage_url";

/** "https://openalex.org/I123" or "i123" -> "I123"; null when it is not an institution id. */
export function institutionIdOf(value: string): string | null {
  const m = /(?:^|\/)([Ii]\d{1,15})$/.exec(value.trim());
  return m && m[1] ? `I${m[1].slice(1)}` : null;
}

/** Rebuilds the abstract text from the inverted index (word -> positions). */
export function abstractFromIndex(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const words: string[] = [];
  let count = 0;
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position >= 20_000) continue;
      words[position] = word;
      if (++count > 20_000) break;
    }
  }
  return words.filter((w) => typeof w === "string").join(" ");
}

const locationSchema = z
  .object({
    landing_page_url: z.string().nullish(),
    pdf_url: z.string().nullish(),
    source: z.object({ display_name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough()
  .nullish();
const workSchema = z
  .object({
    id: z.string(),
    doi: z.string().nullish(),
    display_name: z.string().nullish(),
    publication_date: z.string().nullish(),
    type: z.string().nullish(),
    abstract_inverted_index: z.unknown().optional(),
    authorships: z
      .array(z.object({ author: z.object({ display_name: z.string().nullish() }).passthrough().nullish() }).passthrough())
      .nullish(),
    primary_location: locationSchema,
    best_oa_location: locationSchema,
  })
  .passthrough();
const worksSchema = z.object({ results: z.array(z.unknown()) }).passthrough();

const institutionSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    country_code: z.string().nullish(),
    type: z.string().nullish(),
    works_count: z.number().nullish(),
    homepage_url: z.string().nullish(),
  })
  .passthrough();

/** One work to a RawItem, or null. */
export function workToItem(raw: unknown, institutionName: string): RawItem | null {
  const parsed = workSchema.safeParse(raw);
  if (!parsed.success) return null;
  const work = parsed.data;
  const id = /W\d+$/.exec(work.id)?.[0];
  const title = str(work.display_name)?.replace(/\s+/g, " ");
  if (!id || !title) return null;
  const date = work.publication_date && /^\d{4}-\d{2}-\d{2}$/.test(work.publication_date) ? Date.parse(`${work.publication_date}T00:00:00Z`) : NaN;
  const authors = (work.authorships ?? []).map((a) => str(a.author?.display_name)).filter((n): n is string => Boolean(n));
  const page = `https://openalex.org/${id}`;
  const landing = work.primary_location?.landing_page_url ?? undefined;
  const url = (work.doi && /^https?:\/\//.test(work.doi) ? work.doi : undefined) ?? (landing && /^https?:\/\//.test(landing) ? landing : undefined) ?? page;
  const author = authors.length === 0 ? undefined : authors.length <= 3 ? authors.join(", ") : `${authors.slice(0, 3).join(", ")} et al.`;
  const venue = str(work.primary_location?.source?.display_name);
  return {
    externalId: id,
    url,
    title,
    ...(author ? { author } : {}),
    ...(Number.isFinite(date) ? { publishedAt: date } : {}),
    kind: "paper",
    text: itemText(abstractFromIndex(work.abstract_inverted_index)),
    links: itemLinks([
      url,
      landing,
      work.primary_location?.pdf_url,
      work.best_oa_location?.landing_page_url,
      work.best_oa_location?.pdf_url,
      page,
    ]),
    meta: {
      site: "openalex",
      institution: institutionName,
      authors: authors.slice(0, 50),
      ...(venue ? { venue } : {}),
      ...(work.type ? { workType: work.type } : {}),
      ...(work.doi ? { doi: work.doi } : {}),
      openalexId: id,
    },
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function openAlexWorksUrl(institutionId: string, perPage: number, now: number): string {
  const params = new URLSearchParams({
    filter: `authorships.institutions.lineage:${institutionId},to_publication_date:${utcDay(now)}`,
    sort: "publication_date:desc",
    per_page: String(perPage),
    select: WORK_FIELDS,
  });
  return `${OPENALEX_API}/works?${params.toString()}`;
}

function checkOpenAlex(res: Awaited<ReturnType<typeof send>>, notFound: string): void {
  if (res.status === 429) {
    throw new ConnectorError("rate_limited", "OpenAlex limits the requests of this server now (the free daily budget is used). The app tries again later.");
  }
  checkStatus(res, WHAT, notFound);
}

export async function fetchOpenAlexWorks(ctx: ConnectorContext, config: OpenAlexConfig, perPage: number): Promise<RawItem[]> {
  const id = institutionIdOf(config.institutionId) ?? config.institutionId;
  const res = await send(ctx, { url: openAlexWorksUrl(id, perPage, ctx.now()), headers: { Accept: "application/json" }, timeoutMs: 20_000 }, WHAT);
  checkOpenAlex(res, `OpenAlex has no institution ${id}.`);
  const body = worksSchema.safeParse(parseJson(res.text, WHAT));
  if (!body.success) throw new ConnectorError("bad_response", "OpenAlex sent an answer with no list of works.");
  return body.data.results.map((w) => workToItem(w, config.name)).filter((item): item is RawItem => item !== null);
}

// --- resolve ----------------------------------------------------------------------------

function institutionCandidate(raw: z.infer<typeof institutionSchema>, confidence: number): Candidate | null {
  const id = institutionIdOf(raw.id);
  if (!id) return null;
  const config: OpenAlexConfig = { variant: "openalex_institution", institutionId: id, name: raw.display_name.slice(0, 300) };
  const where = [raw.type, raw.country_code].filter(Boolean).join(", ");
  const works = num(raw.works_count);
  return {
    type: "research",
    name: `${raw.display_name} (papers)`.slice(0, 120),
    description: `New papers with an author from ${raw.display_name}${where ? ` (${where})` : ""}${
      works !== undefined ? `; ${works.toLocaleString("en-US")} works in OpenAlex` : ""
    }.`,
    url: `https://openalex.org/${id}`,
    config,
    confidence,
  };
}

/** The institutions that match a name (at most 3). [] when the lookup fails. */
export async function searchInstitutions(ctx: ConnectorContext, name: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ search: name.slice(0, 200), per_page: "3", select: INSTITUTION_FIELDS });
  try {
    const res = await send(ctx, { url: `${OPENALEX_API}/institutions?${params.toString()}`, headers: { Accept: "application/json" }, timeoutMs: 8000 }, WHAT);
    if (!res.ok) return [];
    const body = z.object({ results: z.array(z.unknown()) }).safeParse(JSON.parse(res.text));
    if (!body.success) return [];
    const out: Candidate[] = [];
    const wanted = name.trim().toLowerCase();
    body.data.results.forEach((raw, index) => {
      const inst = institutionSchema.safeParse(raw);
      if (!inst.success) return;
      const exact = inst.data.display_name.trim().toLowerCase() === wanted;
      const candidate = institutionCandidate(inst.data, exact ? 0.8 : [0.6, 0.45, 0.4][index] ?? 0.4);
      if (candidate) out.push(candidate);
    });
    return out;
  } catch {
    return [];
  }
}

/** One institution by id (for an openalex.org link). A failed lookup gives a candidate with a warning. */
export async function lookupInstitution(ctx: ConnectorContext, id: string): Promise<Candidate[]> {
  try {
    const res = await send(
      ctx,
      { url: `${OPENALEX_API}/institutions/${id}?select=${INSTITUTION_FIELDS}`, headers: { Accept: "application/json" }, timeoutMs: 8000 },
      WHAT,
    );
    if (res.status === 404) return [];
    if (res.ok) {
      const inst = institutionSchema.safeParse(JSON.parse(res.text));
      if (inst.success) {
        const candidate = institutionCandidate(inst.data, 0.95);
        if (candidate) return [candidate];
      }
    }
  } catch {
    // Fall through to the candidate with no name.
  }
  return [
    {
      type: "research",
      name: `OpenAlex institution ${id}`,
      description: `New papers with an author from the OpenAlex institution ${id}.`,
      url: `https://openalex.org/${id}`,
      config: { variant: "openalex_institution", institutionId: id, name: id } satisfies OpenAlexConfig,
      confidence: 0.6,
      warnings: ["OpenAlex did not answer, so the name of the institution is not known. Check the link."],
    },
  ];
}
