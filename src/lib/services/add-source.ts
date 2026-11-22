// The add-source flow (specification §4.7, §7.7, §14, §18.2).
// Nothing is stored before createFromWizard.
import { inArray } from "drizzle-orm";
import { z } from "zod";

import { parseConfig, sourceKey } from "@/lib/connectors/configs";
import { createConnectorContext } from "@/lib/connectors/context";
import { PAGE_PREVIEW_NOTE } from "@/lib/connectors/docs";
import { getConnector, resolveInput } from "@/lib/connectors/registry";
import { ConnectorError, type ConnectorContext, type RawItem } from "@/lib/connectors/types";
import { WEB_SEARCH_PREVIEW_NOTE } from "@/lib/connectors/web_search";
import { getDb } from "@/lib/db/client";
import { feedSources, feeds, sources } from "@/lib/db/schema";
import { getDeps } from "@/lib/deps";
import { HttpError } from "@/lib/http/types";
import { LlmError } from "@/lib/llm/types";
import { judgeDraft } from "@/lib/pipeline";
import { backfillFeedSource, modelGate, readLlmPause } from "@/lib/pipeline/jobs";
import { STARTER_SUGGESTIONS } from "@/lib/seed/suggestions";
import { truncate } from "@/lib/text";
import { MINUTE_MS, SECOND_MS, nowMs } from "@/lib/time";
import { LIMITS, type ItemKind, type Priority, type SourceType } from "@/lib/types";
import { nameSchema, oneLineSchema, prioritySchema, sourceTypeSchema } from "@/lib/form-schemas";

import { countRows, formatUtc, inImmediate, limitError, q } from "./_manage-db";
import { fieldErrorsOf, parseOrThrow, ServiceError } from "./_manage-errors";
import { checkIntervalSchema, idSchema, ownerSchema } from "./_manage-schemas";
import { logActivity } from "./activity";
import type { Actor, PreviewItem, PreviewResult, QualifyResult, Suggestion, WizardCreate, WizardEntry } from "./types";

/** §4.7 step 1: at most 10 entries. */
export const MAX_WIZARD_ENTRIES = 10;
/** §4.7 step 3: one entry shows at most 10 items; several entries at most 3 each. */
export const PREVIEW_LIMIT_ONE = 10;
export const PREVIEW_LIMIT_EACH = 3;
/** §14: at most 10 previews each minute for the whole process. */
export const PREVIEWS_PER_MINUTE = 10;
/** §4.7 step 3: the model judges at most 5 of the newest items in total. */
export const QUALIFY_MAX_ITEMS = 5;
const PREVIEW_TIMEOUT_MS = 30 * SECOND_MS;
const EXCERPT_CHARS = 500;
const ENTRY_MAX_CHARS = 2000;

/** A connector context over the dependencies of this process. */
function connectorContext(signal?: AbortSignal): ConnectorContext {
  const deps = getDeps();
  return createConnectorContext({
    http: deps.http,
    search: deps.search,
    mail: deps.mail,
    now: deps.now,
    env: deps.env,
    usage: deps.usage,
    ...(signal ? { signal } : {}),
  });
}

/** The key (sources.key) of a config, or null when the config is not valid for the type. */
function keyOf(type: SourceType, config: unknown): string | null {
  try {
    return sourceKey(type, parseConfig(type, config));
  } catch {
    return null;
  }
}

/** The sources of the directory with these keys, by key. */
function existingByKey(keys: string[]): Map<string, { id: number; name: string }> {
  if (keys.length === 0) return new Map();
  const rows = getDb()
    .select({ id: sources.id, name: sources.name, key: sources.key })
    .from(sources)
    .where(inArray(sources.key, [...new Set(keys)]))
    .all();
  return new Map(rows.map((row) => [row.key, { id: row.id, name: row.name }]));
}

// ---------------------------------------------------------------------------
// Step 1: resolve
// ---------------------------------------------------------------------------

const entriesSchema = z
  .array(z.string().max(ENTRY_MAX_CHARS, `Use at most ${ENTRY_MAX_CHARS} characters for one entry.`))
  .transform((list) => list.map((entry) => entry.trim()).filter(Boolean))
  .pipe(
    z
      .array(z.string())
      .min(1, "Enter a link, a sender, or a topic.")
      .max(MAX_WIZARD_ENTRIES, `Enter at most ${MAX_WIZARD_ENTRIES} entries at one time.`),
  );

/**
 * Turns each entry into candidates (resolveInput of the registry: each
 * connector has a time limit of 12 s). `existing` is the first candidate
 * whose key is in the directory already.
 */
export async function resolveEntries(inputs: string[], forcedType?: SourceType): Promise<WizardEntry[]> {
  const entries = parseOrThrow(entriesSchema, inputs, "inputs");
  const forced = forcedType === undefined ? undefined : parseOrThrow(sourceTypeSchema, forcedType, "type");
  const ctx = connectorContext();

  const resolved = await Promise.all(
    entries.map(async (input) => {
      try {
        return { input, candidates: await resolveInput(input, ctx, forced) };
      } catch {
        return { input, candidates: [] };
      }
    }),
  );

  const keysOf = resolved.map((entry) => entry.candidates.map((candidate) => keyOf(candidate.type, candidate.config)));
  const known = existingByKey(keysOf.flat().filter((key): key is string => key !== null));
  return resolved.map((entry, index) => {
    const key = keysOf[index]!.find((k) => k !== null && known.has(k));
    const result: WizardEntry = { input: entry.input, candidates: entry.candidates, existing: key ? known.get(key)! : null };
    if (entry.candidates.length === 0) {
      result.error = forced
        ? "This entry is not a source of the chosen type. Check the spelling, or choose another type."
        : "No source was found for this entry. Check the spelling, or paste a full link.";
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Step 3: preview
// ---------------------------------------------------------------------------

const globalForPreview = globalThis as typeof globalThis & { __industryIntelPreviewTimes?: number[] };

/**
 * Takes `n` preview slots of the sliding minute, or none when they do not
 * all fit. On globalThis, so that every bundle of the process shares the count.
 */
function takePreviewSlots(n: number, now: number): boolean {
  const recent = (globalForPreview.__industryIntelPreviewTimes ?? []).filter((at) => at > now - MINUTE_MS);
  globalForPreview.__industryIntelPreviewTimes = recent;
  if (recent.length + n > PREVIEWS_PER_MINUTE) return false;
  for (let i = 0; i < n; i += 1) recent.push(now);
  return true;
}

/** Tests: forgets the previews of the last minute. */
export function resetPreviewLimitForTests(): void {
  globalForPreview.__industryIntelPreviewTimes = [];
}

const previewEntriesSchema = z
  .array(z.object({ type: sourceTypeSchema, name: nameSchema, config: z.unknown() }))
  .min(1, "Choose at least one source to preview.")
  .max(MAX_WIZARD_ENTRIES, `Preview at most ${MAX_WIZARD_ENTRIES} sources at one time.`);

/** A message that is fit to show: connector and HTTP errors say what went wrong; others do not leak details. */
function previewErrorMessage(error: unknown): string {
  if (error instanceof ConnectorError || error instanceof HttpError) return error.message;
  return "The preview failed. Try again later.";
}

function toPreviewItem(item: RawItem): PreviewItem {
  return {
    externalId: item.externalId,
    title: item.title,
    url: item.url ?? null,
    publishedAt: item.publishedAt ?? null,
    excerpt: truncate(item.text.replace(/\s+/g, " ").trim(), EXCERPT_CHARS),
  };
}

function previewNote(type: SourceType, items: RawItem[]): string | undefined {
  if (type === "web_search") return WEB_SEARCH_PREVIEW_NOTE;
  if (type === "docs" && items.some((item) => item.meta?.sample === true)) return PAGE_PREVIEW_NOTE;
  return undefined;
}

async function previewOne(
  entry: { type: SourceType; name: string; config: unknown },
  limit: number,
): Promise<PreviewResult["entries"][number]> {
  const config = (() => {
    try {
      return parseConfig(entry.type, entry.config);
    } catch {
      return null;
    }
  })();
  if (config === null) return { name: entry.name, items: [], error: "The settings of this source are not valid." };

  const connector = getConnector(entry.type);
  const deps = getDeps();
  const need = connector.needs(deps.env, config);
  if (need) return { name: entry.name, items: [], error: need.message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const result = await connector.fetch({ config, cursor: null, mode: "preview", limit, ctx: connectorContext(controller.signal) });
    const items = result.items.slice(0, limit);
    const note = previewNote(entry.type, items);
    return { name: entry.name, items: items.map(toPreviewItem), ...(note ? { note } : {}) };
  } catch (error) {
    return { name: entry.name, items: [], error: previewErrorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches recent items with no write to the database. One fetch counts as
 * one preview against the limit of 10 each minute (§14).
 */
export async function previewSource(entries: Array<{ type: SourceType; name: string; config: unknown }>): Promise<PreviewResult> {
  const list = parseOrThrow(previewEntriesSchema, entries, "entries");
  if (!takePreviewSlots(list.length, nowMs())) {
    throw limitError(`The app makes at most ${PREVIEWS_PER_MINUTE} previews each minute. Wait a minute and try again.`);
  }
  const limit = list.length === 1 ? PREVIEW_LIMIT_ONE : PREVIEW_LIMIT_EACH;
  return { entries: await Promise.all(list.map((entry) => previewOne(entry, limit))) };
}

// ---------------------------------------------------------------------------
// Step 3: would the items enter the feeds?
// ---------------------------------------------------------------------------

const PREVIEW_KIND: Record<SourceType, ItemKind> = {
  x_user: "post",
  x_search: "post",
  podcast: "episode",
  blog: "article",
  github: "release",
  docs: "doc_change",
  newsletter: "email",
  youtube: "video",
  community: "discussion",
  research: "paper",
  web_search: "search_result",
};

const qualifySchema = z.object({
  type: sourceTypeSchema,
  sourceName: nameSchema,
  items: z
    .array(
      z.object({
        externalId: z.string().max(ENTRY_MAX_CHARS),
        title: z.string().max(ENTRY_MAX_CHARS),
        url: z.string().max(ENTRY_MAX_CHARS).nullable(),
        publishedAt: z.number().nullable(),
        excerpt: z.string().max(LIMITS.multiLine),
      }),
    )
    .max(MAX_WIZARD_ENTRIES * PREVIEW_LIMIT_ONE),
  config: z.unknown(),
  feedIds: z.array(idSchema).max(LIMITS.maxFeeds),
  follow: oneLineSchema,
  ignore: oneLineSchema,
  priority: prioritySchema,
});

function unavailable(reason: string): QualifyResult {
  return { available: false, unavailableReason: reason, perFeed: [] };
}

/** Why the model check cannot run now, in words, or null when it can. */
function modelUnavailableReason(now: number): string | null {
  const deps = getDeps();
  const gate = modelGate(now, deps.env);
  if (gate.reason === "no_key") return "The model key is missing, so the app cannot check which items would enter. You can still add the source.";
  if (gate.reason === "paused") {
    const why = readLlmPause().lastError;
    return `The model is not available now${why ? ` (${why})` : ""}. It starts again at ${formatUtc(gate.until ?? now)}. You can still add the source.`;
  }
  if (gate.reason === "budget") return "The model call limit for today is used. You can still add the source.";
  if (deps.usage.remaining("llm_calls_preview") <= 0) {
    return "The limit of preview checks for today is used. You can still add the source.";
  }
  return null;
}

/** The newest items first (items with no date last), at most QUALIFY_MAX_ITEMS. */
function newestItems(items: PreviewItem[]): PreviewItem[] {
  return [...items]
    .sort((a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity))
    .slice(0, QUALIFY_MAX_ITEMS);
}

/**
 * Asks the model whether recent items would enter the selected feeds
 * (judgeDraft, metric llm_calls_preview). Obeys the model gate.
 */
export async function qualifyPreview(args: {
  type: SourceType;
  sourceName: string;
  items: PreviewItem[];
  config: unknown;
  feedIds: number[];
  follow: string;
  ignore: string;
  priority: Priority;
}): Promise<QualifyResult> {
  const data = parseOrThrow(qualifySchema, args);
  const selected =
    data.feedIds.length === 0
      ? []
      : getDb().select({ id: feeds.id, name: feeds.name, archivedAt: feeds.archivedAt }).from(feeds).where(inArray(feeds.id, data.feedIds)).all();
  const active = selected.filter((feed) => feed.archivedAt === null);
  if (active.length === 0) return unavailable("Select at least one feed to see which items would enter it.");
  if (data.items.length === 0) return unavailable("The preview has no items to check.");

  const now = nowMs();
  const closed = modelUnavailableReason(now);
  if (closed) return unavailable(closed);

  const deps = getDeps();
  const judged: Array<{ item: PreviewItem; results: Awaited<ReturnType<typeof judgeDraft>> }> = [];
  let failure: string | null = null;
  for (const item of newestItems(data.items)) {
    try {
      const results = await judgeDraft({
        item: {
          externalId: item.externalId,
          title: item.title,
          kind: PREVIEW_KIND[data.type],
          text: item.excerpt,
          ...(item.url ? { url: item.url } : {}),
          ...(item.publishedAt !== null ? { publishedAt: item.publishedAt } : {}),
        },
        source: { name: data.sourceName, type: data.type },
        feeds: active.map((feed) => ({ feedId: feed.id, follow: data.follow, ignore: data.ignore, priority: data.priority })),
        deps,
      });
      judged.push({ item, results });
    } catch (error) {
      // A model error stops the check; the items judged so far still count.
      failure = error instanceof LlmError ? error.message : "The model check failed.";
      break;
    }
  }
  if (judged.length === 0) return unavailable(`${failure ?? "The model check failed."} You can still add the source.`);

  return {
    available: true,
    perFeed: active.map((feed) => {
      const rows = judged.flatMap(({ item, results }) => {
        const result = results.find((r) => r.feedId === feed.id);
        if (!result) return [];
        return [
          {
            externalId: item.externalId,
            title: item.title,
            relevance: result.relevance,
            reason: result.reason,
            wouldEnter: result.hiddenReason === null,
            hidden: result.hiddenReason,
          },
        ];
      });
      return { feedId: feed.id, feedName: feed.name, wouldEnter: rows.filter((r) => r.wouldEnter).length, total: rows.length, items: rows };
    }),
  };
}

// ---------------------------------------------------------------------------
// Step 4: add
// ---------------------------------------------------------------------------

const httpUrl = z
  .string()
  .trim()
  .max(ENTRY_MAX_CHARS)
  .refine((value) => /^https?:\/\//i.test(value), "Use an address that starts with http:// or https://.");

const wizardSchema = z.object({
  entries: z
    .array(z.object({ type: sourceTypeSchema, name: nameSchema, url: httpUrl.optional(), config: z.unknown() }))
    .min(1, "Add at least one source.")
    .max(MAX_WIZARD_ENTRIES, `Add at most ${MAX_WIZARD_ENTRIES} sources at one time.`),
  common: z.object({
    why: oneLineSchema.min(1, "Say why this source matters."),
    feedIds: z.array(idSchema).max(LIMITS.maxFeeds).transform((ids) => [...new Set(ids)]),
    follow: oneLineSchema,
    ignore: oneLineSchema,
    priority: prioritySchema,
    checkIntervalMinutes: checkIntervalSchema,
    owner: ownerSchema,
  }),
});

/** Each config is validated again with the configSchema of its type. */
function parseEntryConfigs(entries: z.output<typeof wizardSchema>["entries"]) {
  return entries.map((entry, index) => {
    try {
      const config = parseConfig(entry.type, entry.config);
      return { ...entry, config, key: sourceKey(entry.type, config) };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ServiceError("validation", `The settings of ${q(entry.name)} are not valid.`, fieldErrorsOf(error, `entries.${index}.config`));
      }
      throw error;
    }
  });
}

/**
 * Creates one source for each entry (an entry whose key exists is skipped),
 * the feed links, the first check, and the backfill of §7.7, in one
 * transaction with the activity rows.
 */
export async function createFromWizard(
  input: WizardCreate,
  actor: Actor,
): Promise<{
  created: Array<{ id: number; name: string }>;
  skipped: Array<{ name: string; reason: string }>;
  queuedStories: number;
}> {
  const data = parseOrThrow(wizardSchema, input);
  const entries = parseEntryConfigs(data.entries);
  const by = actor.name.trim();

  return inImmediate(() => {
    const feedRows = data.common.feedIds.length
      ? getDb().select({ id: feeds.id, archivedAt: feeds.archivedAt }).from(feeds).where(inArray(feeds.id, data.common.feedIds)).all()
      : [];
    const missing = data.common.feedIds.filter((id) => !feedRows.some((feed) => feed.id === id && feed.archivedAt === null));
    if (missing.length > 0) {
      throw new ServiceError("validation", "A selected feed does not exist or is archived.", { "common.feedIds": "Choose active feeds only." });
    }

    const known = existingByKey(entries.map((entry) => entry.key));
    const seen = new Set<string>();
    const skipped: Array<{ name: string; reason: string }> = [];
    const toCreate = entries.filter((entry) => {
      if (known.has(entry.key)) {
        skipped.push({ name: entry.name, reason: `Already in the directory as ${q(known.get(entry.key)!.name)}.` });
        return false;
      }
      if (seen.has(entry.key)) {
        skipped.push({ name: entry.name, reason: "The same source is twice in the list." });
        return false;
      }
      seen.add(entry.key);
      return true;
    });
    if (countRows("sources") + toCreate.length > LIMITS.maxSources) {
      throw limitError(`The directory can hold at most ${LIMITS.maxSources} sources. Delete sources that you do not use first.`);
    }

    const now = nowMs();
    const created: Array<{ id: number; name: string }> = [];
    let queuedStories = 0;
    for (const entry of toCreate) {
      const row = getDb()
        .insert(sources)
        .values({
          type: entry.type,
          key: entry.key,
          name: entry.name,
          url: entry.url ?? null,
          config: entry.config,
          why: data.common.why,
          addedBy: by,
          owner: data.common.owner,
          checkIntervalMinutes: data.common.checkIntervalMinutes,
          nextCheckAt: now,
          checkRequestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: sources.id })
        .get();
      for (const feedId of data.common.feedIds) {
        getDb()
          .insert(feedSources)
          .values({
            feedId,
            sourceId: row.id,
            priority: data.common.priority,
            follow: data.common.follow,
            ignore: data.common.ignore,
            addedBy: by,
            createdAt: now,
          })
          .run();
        const backfill = backfillFeedSource({ feedId, sourceId: row.id, requestedBy: by, now });
        queuedStories += backfill.queuedStories + backfill.queuedItems;
      }
      logActivity(actor, "source.create", "source", row.id, `Added the source ${q(entry.name)} (${entry.type}).`);
      created.push({ id: row.id, name: entry.name });
    }
    return { created, skipped, queuedStories };
  });
}

// ---------------------------------------------------------------------------
// Starter suggestions (§12)
// ---------------------------------------------------------------------------

/** The starter suggestions (§12) that are not in the directory, for one feed or for all. */
export async function listSuggestions(feedSlug?: string): Promise<Suggestion[]> {
  const known = new Set(getDb().select({ key: sources.key }).from(sources).all().map((row) => row.key));
  return STARTER_SUGGESTIONS.filter((suggestion) => {
    if (feedSlug && suggestion.feedSlug !== feedSlug) return false;
    const key = keyOf(suggestion.type, suggestion.config);
    return key !== null && !known.has(key);
  });
}

