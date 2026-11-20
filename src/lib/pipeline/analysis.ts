// The deeper analysis on demand (§7.5).
import { getSqlite } from "@/lib/db/client";
import { effectiveBriefFormatOf } from "@/lib/ranking/recompute";
import { extractArticle } from "@/lib/text";
import { SOURCE_TYPE_LABELS, type SourceType } from "@/lib/types";

import { asLlmError, noteModelSuccess, notePauseFor } from "./model-errors";
import { readTeamProfile } from "./prompt-data";
import { analysisSystemPrompt, analysisUserPrompt, isoDate, type AnalysisSource } from "./prompts";
import { parseJsonText, readStory } from "./rows";
import { analysisSchema, toAnalysisContent, type AnalysisRaw } from "./schemas";
import type { PipelineDeps } from "./types";

/** After this many item errors the analysis is `failed`. */
export const MAX_ANALYSIS_ATTEMPTS = 3;
/** The primary URL and at most 2 more item URLs are fetched. */
const MAX_FETCHES = 3;
/** At most this many stored item texts go into the prompt. */
const MAX_ITEM_SOURCES = 5;
const FETCH_TIMEOUT_MS = 20_000;
/** The analysis model thinks before it writes: the thinking tokens count as output. */
const ANALYSIS_MAX_OUTPUT_TOKENS = 16_000;

type AnalysisRow = { id: number; feedId: number; storyId: number };

type StoryItem = {
  id: number;
  url: string | null;
  title: string;
  kind: string;
  publishedAt: number | null;
  text: string;
  meta: string;
  sourceName: string;
  sourceType: SourceType;
};

/** Claims the oldest queued analysis: running, stage "Reading the sources". */
function claimAnalysis(now: number): AnalysisRow | null {
  const sqlite = getSqlite();
  return sqlite
    .transaction((): AnalysisRow | null => {
      const row = sqlite
        .prepare(
          `SELECT id, feed_id AS feedId, story_id AS storyId FROM analyses
            WHERE status = 'queued' ORDER BY requested_at, id LIMIT 1`,
        )
        .get() as AnalysisRow | undefined;
      if (!row) return null;
      sqlite
        .prepare(
          `UPDATE analyses SET status = 'running', stage = 'Reading the sources', started_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, row.id);
      return row;
    })
    .immediate();
}

function setStage(id: number, stage: string, now: number): void {
  getSqlite().prepare("UPDATE analyses SET stage = ?, updated_at = ? WHERE id = ?").run(stage, now, id);
}

function storyItems(storyId: number): StoryItem[] {
  return getSqlite()
    .prepare(
      `SELECT i.id, i.url, i.title, i.kind, i.published_at AS publishedAt, i.content_text AS text, i.meta,
              s.name AS sourceName, s.type AS sourceType
         FROM items i JOIN sources s ON s.id = i.source_id
        WHERE i.story_id = ?
        ORDER BY LENGTH(i.content_text) DESC, i.id`,
    )
    .all(storyId) as StoryItem[];
}

function isHttp(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

/** The primary URL first, then the other item URLs, with no duplicates. */
function sourceUrls(primaryUrl: string | null, items: StoryItem[]): string[] {
  const urls: string[] = [];
  for (const url of [primaryUrl, ...items.map((item) => item.url)]) {
    if (isHttp(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** Fetches the article text of a page. A failure is not fatal: the stored texts stay. */
async function fetchArticle(deps: PipelineDeps, url: string): Promise<string | null> {
  try {
    const response = await deps.http.request({ url, timeoutMs: FETCH_TIMEOUT_MS });
    if (!response.ok || !response.text) return null;
    const article = extractArticle(response.text, response.url || url);
    return article.text.trim() ? article.text : null;
  } catch {
    return null;
  }
}

function basisOf(meta: string): string | null {
  const value = parseJsonText(meta) as Record<string, unknown> | null;
  return value && typeof value.basis === "string" ? value.basis : null;
}

/** The sources of the prompt: a fetched page replaces the stored text of its item. */
async function readSources(deps: PipelineDeps, primaryUrl: string | null, items: StoryItem[]): Promise<{ sources: AnalysisSource[]; allowedUrls: string[] }> {
  const allowedUrls = sourceUrls(primaryUrl, items);
  const fetched = new Map<string, string>();
  for (const url of allowedUrls.slice(0, MAX_FETCHES)) {
    const text = await fetchArticle(deps, url);
    if (text) fetched.set(url, text);
  }

  const sources: AnalysisSource[] = [];
  const used = new Set<string>();
  for (const item of items.slice(0, MAX_ITEM_SOURCES)) {
    const page = item.url ? fetched.get(item.url) : undefined;
    if (item.url) used.add(item.url);
    const date = item.publishedAt !== null ? `, ${isoDate(item.publishedAt)}` : "";
    sources.push({
      label: `${item.sourceName} (${SOURCE_TYPE_LABELS[item.sourceType]}), ${item.kind}${date}: ${item.title}${page ? " (full page)" : ""}`,
      url: item.url,
      basis: basisOf(item.meta),
      text: page ?? item.text,
    });
  }
  for (const [url, text] of fetched) {
    if (!used.has(url)) sources.push({ label: "Full page of the primary link", url, basis: null, text });
  }
  return { sources, allowedUrls };
}

function finishWith(id: number, values: { status: "queued" | "done" | "failed"; attempts?: number; error?: string | null; content?: unknown; model?: string | null }, now: number): void {
  const finished = values.status === "done" || values.status === "failed";
  getSqlite()
    .prepare(
      `UPDATE analyses
          SET status = @status, stage = NULL, updated_at = @now,
              attempts = COALESCE(@attempts, attempts),
              error = @error,
              content = COALESCE(@content, content),
              model = COALESCE(@model, model),
              finished_at = CASE WHEN @finished = 1 THEN @now ELSE finished_at END
        WHERE id = @id`,
    )
    .run({
      id,
      now,
      status: values.status,
      attempts: values.attempts ?? null,
      error: values.error ?? null,
      content: values.content === undefined ? null : JSON.stringify(values.content),
      model: values.model ?? null,
      finished: finished ? 1 : 0,
    });
}

/** An item error: attempts + 1; after 3 attempts the analysis is `failed` with the error. */
function recordAnalysisItemError(id: number, message: string, now: number): void {
  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      const current = sqlite.prepare("SELECT attempts FROM analyses WHERE id = ?").get(id) as { attempts: number } | undefined;
      if (!current) return;
      const attempts = current.attempts + 1;
      const status = attempts >= MAX_ANALYSIS_ATTEMPTS ? "failed" : "queued";
      finishWith(id, { status, attempts, error: message.slice(0, 300) }, now);
    })
    .immediate();
}

type FeedRow = { name: string; purpose: string; projectContext: string; briefFormat: string };

/** Claims the oldest queued analysis and writes it (§7.5). True when it did work. */
export async function runNextAnalysis(deps: PipelineDeps): Promise<boolean> {
  const row = claimAnalysis(deps.now());
  if (!row) return false;

  const story = readStory(row.storyId);
  const feed = getSqlite()
    .prepare("SELECT name, purpose, project_context AS projectContext, brief_format AS briefFormat FROM feeds WHERE id = ?")
    .get(row.feedId) as FeedRow | undefined;
  if (!story || !feed) {
    finishWith(row.id, { status: "failed", error: "The story or the feed no longer exists." }, deps.now());
    return true;
  }

  const items = storyItems(story.id);
  const { sources, allowedUrls } = await readSources(deps, story.primaryUrl, items);
  setStage(row.id, "Writing", deps.now());

  const format = effectiveBriefFormatOf(feed.briefFormat);
  try {
    const reply = await deps.llm.json<AnalysisRaw>({
      task: "analysis",
      schema: analysisSchema,
      system: analysisSystemPrompt(),
      user: analysisUserPrompt({
        now: deps.now(),
        team: readTeamProfile(),
        feed: { ...feed, depth: format.technicalDepth, suggestedActions: format.suggestedActions },
        story: { id: story.id, headline: story.headline, summary: story.summary, firstSeenAt: story.firstSeenAt, category: story.category },
        allowedUrls,
        sources,
      }),
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
    });
    const content = toAnalysisContent(reply.data, { allowedUrls, suggestedActions: format.suggestedActions });
    const now = deps.now();
    noteModelSuccess(now);
    finishWith(row.id, { status: "done", content, model: reply.model, error: null }, now);
  } catch (thrown) {
    const error = asLlmError(thrown);
    const now = deps.now();
    if (notePauseFor(error, now) === "service") {
      finishWith(row.id, { status: "queued" }, now);
    } else {
      recordAnalysisItemError(row.id, error.message, now);
    }
  }
  return true;
}
