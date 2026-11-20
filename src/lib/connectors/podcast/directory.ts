// Keyless podcast directory lookups for `resolve`: the iTunes Search API
// (search and lookup) and the public Spotify show page / oEmbed.
import { z } from "zod";

import { decodeEntities } from "@/lib/text";

import { assertOk, httpGet, metaContent } from "../blog/http";
import { ConnectorError, type ConnectorContext } from "../types";

export const ITUNES_SEARCH = "https://itunes.apple.com/search";
export const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";
export const SPOTIFY_OEMBED = "https://open.spotify.com/oembed";

const itunesResultSchema = z.object({
  collectionId: z.number().int().positive(),
  collectionName: z.string().default(""),
  artistName: z.string().default(""),
  feedUrl: z.string().optional(),
  collectionViewUrl: z.string().optional(),
  primaryGenreName: z.string().optional(),
  trackCount: z.number().optional(),
  releaseDate: z.string().optional(),
  kind: z.string().optional(),
  wrapperType: z.string().optional(),
});
const itunesResponseSchema = z.object({
  resultCount: z.number().optional(),
  results: z.array(z.unknown()).default([]),
});

export interface DirectoryShow {
  itunesId: number;
  name: string;
  artist: string;
  feedUrl: string;
  appleUrl?: string;
  genre?: string;
  episodes?: number;
  latest?: number;
}

/** Shows of an iTunes answer that have a feed address. */
export function parseItunes(text: string): DirectoryShow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConnectorError("bad_response", "The Apple podcast directory sent an answer that the app cannot read.");
  }
  const parsed = itunesResponseSchema.safeParse(data);
  if (!parsed.success) throw new ConnectorError("bad_response", "The Apple podcast directory sent an answer that the app cannot read.");
  const shows: DirectoryShow[] = [];
  for (const raw of parsed.data.results) {
    const r = itunesResultSchema.safeParse(raw);
    if (!r.success) continue;
    const v = r.data;
    if (v.kind !== undefined && v.kind !== "podcast") continue;
    if (!v.feedUrl || !/^https?:\/\//i.test(v.feedUrl)) continue;
    const show: DirectoryShow = {
      itunesId: v.collectionId,
      name: v.collectionName.trim(),
      artist: v.artistName.trim(),
      feedUrl: v.feedUrl.trim(),
    };
    if (v.collectionViewUrl) show.appleUrl = v.collectionViewUrl.replace(/\?uo=\d+$/, "");
    if (v.primaryGenreName) show.genre = v.primaryGenreName;
    if (v.trackCount !== undefined) show.episodes = v.trackCount;
    const latest = v.releaseDate ? Date.parse(v.releaseDate) : NaN;
    if (Number.isFinite(latest)) show.latest = latest;
    shows.push(show);
  }
  return shows;
}

/** iTunes podcast search (keyless). */
export async function searchShows(ctx: ConnectorContext, term: string, limit: number): Promise<DirectoryShow[]> {
  const url = `${ITUNES_SEARCH}?media=podcast&limit=${Math.max(1, Math.min(10, limit))}&term=${encodeURIComponent(term)}`;
  const res = await httpGet(ctx, url, { accept: "application/json", timeoutMs: 10_000 });
  assertOk(res, "The Apple podcast directory");
  return parseItunes(res.text);
}

/** iTunes lookup of one show by id (keyless). */
export async function lookupShow(ctx: ConnectorContext, id: number): Promise<DirectoryShow | null> {
  const res = await httpGet(ctx, `${ITUNES_LOOKUP}?id=${id}`, { accept: "application/json", timeoutMs: 10_000 });
  assertOk(res, "The Apple podcast directory");
  return parseItunes(res.text).find((s) => s.itunesId === id) ?? null;
}

/** The show id of an Apple Podcasts link (".../id1502871393"). */
export function appleIdOf(url: URL): number | null {
  if (!/(^|\.)(podcasts|itunes)\.apple\.com$/i.test(url.hostname)) return null;
  const m = /\/id(\d{3,15})(?:$|[/?])/.exec(url.pathname + "/") ?? /[?&]id=(\d{3,15})/.exec(url.search);
  return m?.[1] ? Number(m[1]) : null;
}

/** The show id of a Spotify show link (open.spotify.com/show/<id>, also with an /intl-xx prefix). */
export function spotifyShowIdOf(url: URL): string | null {
  if (url.hostname.toLowerCase() !== "open.spotify.com") return null;
  const m = /^\/(?:intl-[a-z-]+\/)?show\/([A-Za-z0-9]{10,40})(?:\/|$)/.exec(url.pathname);
  return m?.[1] ?? null;
}

export interface SpotifyShowInfo {
  /** The show title, from the show page. */
  title: string | null;
  /** The publisher, from the og:description of the show page ("Podcast · <publisher> · …"). */
  publisher: string | null;
  /** The oEmbed title. Checked on 2026-11-20: for a show link it is the title of the newest episode, not of the show. */
  oembedTitle: string | null;
}

/**
 * The title of a Spotify show. The show page (og:title) has the show title.
 * The oEmbed answer is read only when the page gives no title.
 */
export async function spotifyShow(ctx: ConnectorContext, showId: string): Promise<SpotifyShowInfo> {
  const info: SpotifyShowInfo = { title: null, publisher: null, oembedTitle: null };
  const pageUrl = `https://open.spotify.com/show/${showId}`;
  try {
    const res = await httpGet(ctx, pageUrl, { timeoutMs: 10_000 });
    if (res.ok) {
      const title = metaContent(res.text, "og:title");
      if (title) info.title = decodeEntities(title).trim() || null;
      const description = decodeEntities(metaContent(res.text, "og:description") ?? "");
      const parts = description.split("·").map((p) => p.trim());
      if (parts.length >= 2 && /^podcast$/i.test(parts[0] ?? "") && parts[1]) info.publisher = parts[1];
    }
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
  }
  if (info.title) return info;
  const res = await httpGet(ctx, `${SPOTIFY_OEMBED}?url=${encodeURIComponent(pageUrl)}`, { accept: "application/json", timeoutMs: 10_000 });
  assertOk(res, "Spotify");
  try {
    const data = z.object({ title: z.string() }).safeParse(JSON.parse(res.text));
    if (data.success) info.oembedTitle = data.data.title.trim() || null;
  } catch {
    // no title
  }
  return info;
}

/** Lower case, letters and digits only, single spaces. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How well a directory show matches the name that a person typed: 1 exact, 0.8 starts with it, 0.5 has it, else 0. */
export function nameMatch(query: string, show: Pick<DirectoryShow, "name">): number {
  const q = normalizeName(query);
  const n = normalizeName(show.name);
  if (q === "" || n === "") return 0;
  if (q === n) return 1;
  if (n.startsWith(`${q} `)) return 0.8;
  if (` ${n} `.includes(` ${q} `)) return 0.5;
  return 0;
}
