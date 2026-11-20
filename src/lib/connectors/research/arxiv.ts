// arXiv through its API (https://export.arxiv.org/api/query): one request
// each 3 seconds inside this connector (all arxiv.org hosts).
//
// Checked live on 2026-11-20: https on export.arxiv.org answers 200 with an
// Atom feed (`opensearch:totalResults`, `entry` with `id`
// http://arxiv.org/abs/<id>v<n>, `published`, `link rel="alternate"` and
// `title="pdf"`, `author/name`, `category`, `arxiv:primary_category`,
// `arxiv:comment`); a bad query answers one entry with the title "Error";
// `au:"First Last"` finds an author; the author page arxiv.org/a/<id> has the
// title "<Name>'s articles on arXiv"; no ETag / Last-Modified.
import { extractLinks, htmlToText } from "@/lib/text";
import { asArray, attr, isObject, parseXml, textOf, type XmlNode } from "@/lib/feeds/xml";

import type { ResearchConfig } from "../configs";
import { ConnectorError, type ConnectorContext, type RawItem } from "../types";
import { checkStatus, isoTime, itemLinks, itemText, send, sleep } from "../community/shared";

export const ARXIV_API = "https://export.arxiv.org/api/query";
const WHAT = "arXiv";

// --- pacing: one request each 3 s ---------------------------------------------

let minIntervalMs = 3000;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

/** Tests: set the pause between two arXiv requests (default 3000 ms). */
export function setArxivPacingForTests(ms: number | null): void {
  minIntervalMs = ms ?? 3000;
  lastRequestAt = 0;
  queue = Promise.resolve();
}

/** Waits for the turn of this request: at least 3 s after the start of the previous arXiv request. */
async function waitTurn(signal?: AbortSignal): Promise<void> {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => (release = resolve));
  try {
    await previous;
    await sleep(lastRequestAt + minIntervalMs - Date.now(), signal);
    lastRequestAt = Date.now();
  } finally {
    release();
  }
}

/** A GET to an arXiv host, after its turn. */
export async function arxivGet(ctx: ConnectorContext, url: string, accept: string): Promise<Awaited<ReturnType<typeof send>>> {
  await waitTurn(ctx.signal);
  return send(ctx, { url, headers: { Accept: accept }, timeoutMs: 30_000 }, WHAT);
}

// --- the query ----------------------------------------------------------------------

/** The query "*" takes every new paper of the categories. */
export const ALL_PAPERS = "*";

const FIELD_PREFIX = /\b(?:ti|au|abs|co|jr|cat|rn|id|all):/i;

/** The search_query text of a config. */
export function arxivSearchQuery(config: Exclude<ResearchConfig, { variant: "openalex_institution" }>): string {
  if (config.variant === "arxiv_author") {
    const name = config.author.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
    return `au:"${name}"`;
  }
  const parts: string[] = [];
  const q = config.query.trim();
  if (q !== ALL_PAPERS && q !== "") {
    if (FIELD_PREFIX.test(q)) {
      // The person wrote the arXiv syntax.
      parts.push(`(${q})`);
    } else {
      const terms: string[] = [];
      for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
        if (m[1] !== undefined) {
          const phrase = m[1].replace(/[^\p{L}\p{N}\s.+_-]/gu, " ").replace(/\s+/g, " ").trim();
          if (phrase) terms.push(`all:"${phrase}"`);
        } else if (m[2] !== undefined) {
          const word = m[2].replace(/[^\p{L}\p{N}.+_-]/gu, "");
          if (word && !/^(and|or|andnot)$/i.test(word)) terms.push(`all:${word}`);
        }
        if (terms.length >= 12) break;
      }
      if (terms.length > 0) parts.push(terms.length === 1 ? terms[0]! : `(${terms.join(" AND ")})`);
    }
  }
  const cats = config.categories.filter((c) => /^[A-Za-z-]+(?:\.[A-Za-z-]+)?$/.test(c)).map((c) => `cat:${c}`);
  if (cats.length > 0) parts.push(cats.length === 1 ? cats[0]! : `(${cats.join(" OR ")})`);
  if (parts.length === 0) {
    throw new ConnectorError("bad_response", "This research source has no words and no category to search for.");
  }
  return parts.join(" AND ");
}

export function arxivQueryUrl(searchQuery: string, maxResults: number): string {
  const params = new URLSearchParams({
    search_query: searchQuery,
    sortBy: "submittedDate",
    sortOrder: "descending",
    start: "0",
    max_results: String(maxResults),
  });
  return `${ARXIV_API}?${params.toString().replace(/\+/g, "%20")}`;
}

// --- the response ---------------------------------------------------------------------

/** "http://arxiv.org/abs/2411.01234v2" -> "2411.01234"; "…/abs/cs/0112017v1" -> "cs/0112017". */
export function arxivIdOf(idUrl: string): { id: string; version: string | null } | null {
  const m = /arxiv\.org\/abs\/(.+?)(v\d+)?$/i.exec(idUrl.trim());
  if (!m || !m[1]) return null;
  const id = m[1];
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(id)) return null;
  return { id, version: m[2] ?? null };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function authorLine(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} et al.`;
}

/** Parses an arXiv API answer into items (in the order of the answer). Throws for an error entry. */
export function parseArxivFeed(xml: string): RawItem[] {
  let root;
  try {
    root = parseXml(xml);
  } catch (error) {
    throw new ConnectorError("bad_response", "arXiv sent an answer that is not valid XML.", { cause: error });
  }
  if (!root || root.name.toLowerCase() !== "feed") throw new ConnectorError("bad_response", "arXiv sent an answer that is not an Atom feed.");
  const items: RawItem[] = [];
  for (const node of asArray(root.node.entry)) {
    if (!isObject(node)) continue;
    const idText = textOf(node.id);
    const title = oneLine(textOf(node.title));
    if (/\/api\/errors/i.test(idText) || (title === "Error" && !arxivIdOf(idText))) {
      const reason = oneLine(textOf(node.summary)) || "unknown error";
      throw new ConnectorError("bad_response", `arXiv refused the query: ${reason}.`);
    }
    const parsedId = arxivIdOf(idText);
    if (!parsedId || !title) continue;
    const { id, version } = parsedId;
    const abstract = oneLine(textOf(node.summary));
    const authors = asArray(node.author)
      .map((a: XmlNode) => (isObject(a) ? oneLine(textOf(a.name)) : ""))
      .filter((name) => name !== "");
    const categories = asArray(node.category)
      .map((c) => attr(c, "term"))
      .filter((term): term is string => Boolean(term));
    const primaryCategory = attr(node["arxiv:primary_category"], "term");
    const comment = oneLine(textOf(node["arxiv:comment"]));
    const doi = oneLine(textOf(node["arxiv:doi"]));
    const published = isoTime(textOf(node.published));
    const updated = isoTime(textOf(node.updated));
    const abs = `https://arxiv.org/abs/${id}`;
    const pdf = `https://arxiv.org/pdf/${id}`;
    const author = authorLine(authors);
    items.push({
      externalId: id,
      url: abs,
      title,
      ...(author ? { author } : {}),
      ...(published !== undefined ? { publishedAt: published } : {}),
      kind: "paper",
      text: itemText(abstract),
      links: itemLinks([abs, pdf, ...(comment ? extractLinks(comment) : []), doi ? `https://doi.org/${doi}` : null]),
      meta: {
        site: "arxiv",
        authors: authors.slice(0, 50),
        categories,
        ...(primaryCategory ? { primaryCategory } : {}),
        ...(version ? { version } : {}),
        ...(comment ? { comment: comment.slice(0, 500) } : {}),
        ...(doi ? { doi } : {}),
        pdfUrl: pdf,
        ...(updated !== undefined ? { updatedAt: updated } : {}),
      },
    });
  }
  return items;
}

/** Runs one API query. */
export async function arxivSearch(ctx: ConnectorContext, searchQuery: string, maxResults: number): Promise<RawItem[]> {
  const res = await arxivGet(ctx, arxivQueryUrl(searchQuery, maxResults), "application/atom+xml");
  if (res.status === 400 && res.text.includes("<feed")) return parseArxivFeed(res.text);
  if (res.status === 503) throw new ConnectorError("rate_limited", "arXiv asks the app to wait (status 503). The app tries again later.");
  checkStatus(res, WHAT, "The arXiv API answered 404.");
  return parseArxivFeed(res.text);
}

/** The author name of an arXiv author page (arxiv.org/a/<id>), or null. */
export function authorNameFromPage(html: string): string | null {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  if (!title) return null;
  const m = /^\s*(.+?)['’]s articles on arXiv\s*$/i.exec(htmlToText(title));
  return m && m[1] ? m[1].trim() : null;
}
