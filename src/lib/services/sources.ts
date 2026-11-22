// The shared source directory (specification §4.5, §4.6, §5, §10, §18.2).
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { IDENTITY_FIELDS, credentialNeeds, parseConfig } from "@/lib/connectors/configs";
import { getDb, getSqlite } from "@/lib/db/client";
import { items, sourceChecks, sourceFlags, sources, type SourceDbRow } from "@/lib/db/schema";
import { refreshStories } from "@/lib/pipeline/jobs";
import { nowMs } from "@/lib/time";
import { FEEDBACK_REASONS, emptyVotes, type FeedbackReason, type HiddenReason, type SourceType } from "@/lib/types";
import { nameSchema, oneLineSchema } from "@/lib/form-schemas";

import { inImmediate, q } from "./_manage-db";
import { fieldErrorsOf, notFound, parseOrThrow, ServiceError } from "./_manage-errors";
import { STATS_WINDOW_MS, signalRateOf, sourceStats, toSourceRows, workerEnvView } from "./_manage-source-rows";
import { checkIntervalSchema, ownerSchema } from "./_manage-schemas";
import { logActivity } from "./activity";
import type { Actor, ItemOutcome, SourceDetail, SourceRow, SourceStatus } from "./types";

const RECENT_ITEMS = 20;
const RECENT_CHECKS = 20;
const MAX_FLAGS_SHOWN = 50;

function requireSource(id: number): SourceDbRow {
  const row = Number.isInteger(id) ? getDb().select().from(sources).where(eq(sources.id, id)).get() : undefined;
  if (!row) throw notFound("The source");
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSources(filter?: {
  type?: SourceType;
  status?: SourceStatus;
  feedId?: number;
  owner?: string;
  q?: string;
  sort?: "name" | "last_check" | "useful";
}): Promise<SourceRow[]> {
  const f = filter ?? {};
  const all = getDb().select().from(sources).all();
  const pool = f.type ? all.filter((row) => row.type === f.type) : all;
  let rows = toSourceRows(pool);

  if (f.status) rows = rows.filter((row) => row.status === f.status);
  if (f.feedId !== undefined) rows = rows.filter((row) => row.feeds.some((feed) => feed.id === f.feedId));
  const owner = f.owner?.trim().toLowerCase();
  if (owner) rows = rows.filter((row) => row.owner?.trim().toLowerCase() === owner);
  const needle = f.q?.trim().toLowerCase();
  if (needle) rows = rows.filter((row) => row.name.toLowerCase().includes(needle));

  const byName = (a: SourceRow, b: SourceRow) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id - b.id;
  const compare: Record<NonNullable<typeof f.sort>, (a: SourceRow, b: SourceRow) => number> = {
    name: byName,
    last_check: (a, b) => (b.lastSuccessAt ?? -1) - (a.lastSuccessAt ?? -1) || byName(a, b),
    useful: (a, b) => b.usefulStories - a.usefulStories || byName(a, b),
  };
  const sort = compare[f.sort ?? "name"];
  // §4.5 "Owner: me": the sources with unresolved flags come first.
  const flagsFirst = (a: SourceRow, b: SourceRow) => Number(b.openFlags > 0) - Number(a.openFlags > 0);
  return rows.sort(owner ? (a, b) => flagsFirst(a, b) || sort(a, b) : sort);
}

export async function getSource(id: number): Promise<SourceDetail | null> {
  if (!Number.isInteger(id)) return null;
  const source = getDb().select().from(sources).where(eq(sources.id, id)).get();
  if (!source) return null;
  const now = nowMs();
  const [row] = toSourceRows([source], { now, oneId: id });
  const stats = sourceStats(now, id).get(id);
  const counts = getSqlite()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM items WHERE source_id = @id) AS itemCount,
              (SELECT COUNT(*) FROM stories s
                WHERE EXISTS (SELECT 1 FROM items i WHERE i.story_id = s.id AND i.source_id = @id)
                  AND NOT EXISTS (SELECT 1 FROM items i WHERE i.story_id = s.id AND i.source_id <> @id)) AS soleStoryCount`,
    )
    .get({ id }) as { itemCount: number; soleStoryCount: number };

  return {
    ...row!,
    itemCount: counts.itemCount,
    soleStoryCount: counts.soleStoryCount,
    why: source.why,
    config: source.config,
    checkIntervalMinutes: source.checkIntervalMinutes,
    createdAt: source.createdAt,
    nextCheckAt: source.nextCheckAt,
    checkRequested: source.checkRequestedAt !== null,
    lastError: source.lastError,
    feedLinks: feedLinksOf(id),
    checks: getDb()
      .select()
      .from(sourceChecks)
      .where(eq(sourceChecks.sourceId, id))
      .orderBy(desc(sourceChecks.startedAt), desc(sourceChecks.id))
      .limit(RECENT_CHECKS)
      .all()
      .map((check) => ({
        startedAt: check.startedAt,
        finishedAt: check.finishedAt,
        ok: check.ok,
        itemsFound: check.itemsFound,
        itemsNew: check.itemsNew,
        error: check.error,
      })),
    stats: {
      itemsFetched: stats?.itemsFetched ?? 0,
      itemsJudged: stats?.itemsJudged ?? 0,
      storiesShown: stats?.storiesShown ?? 0,
      votes: votesOnSource(id, now),
      signalRate: stats ? signalRateOf(stats) : null,
      usefulStories: stats?.usefulStories ?? 0,
    },
    flags: getDb()
      .select()
      .from(sourceFlags)
      .where(eq(sourceFlags.sourceId, id))
      .orderBy(sql`${sourceFlags.resolvedAt} IS NOT NULL`, desc(sourceFlags.createdAt), desc(sourceFlags.id))
      .limit(MAX_FLAGS_SHOWN)
      .all()
      .map((flag) => ({
        id: flag.id,
        note: flag.note,
        createdBy: flag.createdBy,
        createdAt: flag.createdAt,
        resolvedAt: flag.resolvedAt,
        resolvedBy: flag.resolvedBy,
      })),
    recentItems: recentItemsOf(id),
  };
}

/** One row for each active feed (§4.6 "Feeds"). */
function feedLinksOf(sourceId: number): SourceDetail["feedLinks"] {
  const rows = getSqlite()
    .prepare(
      `SELECT f.id AS feedId, f.slug, f.name, fs.source_id AS linked, fs.priority, fs.follow, fs.ignore
         FROM feeds f LEFT JOIN feed_sources fs ON fs.feed_id = f.id AND fs.source_id = ?
        WHERE f.archived_at IS NULL ORDER BY f.position, f.id`,
    )
    .all(sourceId) as Array<{
    feedId: number;
    slug: string;
    name: string;
    linked: number | null;
    priority: "high" | "normal" | "low" | null;
    follow: string | null;
    ignore: string | null;
  }>;
  return rows.map((row) => ({
    feedId: row.feedId,
    slug: row.slug,
    name: row.name,
    included: row.linked !== null,
    priority: row.priority ?? "normal",
    follow: row.follow ?? "",
    ignore: row.ignore ?? "",
  }));
}

/** Votes (30 days) in any feed on the stories that have an item of the source. */
function votesOnSource(sourceId: number, now: number): Record<FeedbackReason, number> {
  const votes = emptyVotes();
  const rows = getSqlite()
    .prepare(
      `SELECT reason, COUNT(*) AS n FROM feedback
        WHERE created_at >= ? AND story_id IN (SELECT story_id FROM items WHERE source_id = ? AND story_id IS NOT NULL)
        GROUP BY reason`,
    )
    .all(now - STATS_WINDOW_MS, sourceId) as Array<{ reason: string; n: number }>;
  for (const row of rows) {
    if ((FEEDBACK_REASONS as readonly string[]).includes(row.reason)) votes[row.reason as FeedbackReason] = row.n;
  }
  return votes;
}

/** The last 20 items with their outcome in each active feed that uses the source. */
function recentItemsOf(sourceId: number): ItemOutcome[] {
  const recent = getDb()
    .select()
    .from(items)
    .where(eq(items.sourceId, sourceId))
    .orderBy(desc(items.fetchedAt), desc(items.id))
    .limit(RECENT_ITEMS)
    .all();
  const feedsOfSource = getSqlite()
    .prepare(
      `SELECT f.id, f.slug, f.name FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
        WHERE fs.source_id = ? AND f.archived_at IS NULL ORDER BY f.position, f.id`,
    )
    .all(sourceId) as Array<{ id: number; slug: string; name: string }>;
  const storyIds = [...new Set(recent.map((item) => item.storyId).filter((id): id is number => id !== null))];
  const verdicts = new Map<string, { relevance: number; hidden: HiddenReason | null }>();
  if (storyIds.length > 0) {
    const rows = getSqlite()
      .prepare(
        `SELECT feed_id AS feedId, story_id AS storyId, relevance, hidden_reason AS hidden FROM judgements
          WHERE story_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(storyIds)) as Array<{ feedId: number; storyId: number; relevance: number; hidden: HiddenReason | null }>;
    for (const row of rows) verdicts.set(`${row.feedId}:${row.storyId}`, { relevance: row.relevance, hidden: row.hidden });
  }

  return recent.map((item) => ({
    itemId: item.id,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    judgeStatus: item.judgeStatus,
    skipReason: item.skipReason,
    storyId: item.storyId,
    perFeed: feedsOfSource.map((feed) => {
      const verdict = item.storyId === null ? undefined : verdicts.get(`${feed.id}:${item.storyId}`);
      return {
        feedSlug: feed.slug,
        feedName: feed.name,
        relevance: verdict?.relevance ?? null,
        hidden: verdict?.hidden ?? null,
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const updateSourceSchema = z.object({
  name: nameSchema.optional(),
  why: oneLineSchema.min(1, "Say why this source matters.").optional(),
  owner: ownerSchema.optional(),
  checkIntervalMinutes: checkIntervalSchema.optional(),
  config: z.unknown().optional(),
});

/** The identity fields (IDENTITY_FIELDS) whose value differs between two parsed configs. */
function changedIdentityFields(type: SourceType, before: unknown, after: unknown): string[] {
  const read = (config: unknown, field: string) => JSON.stringify((config as Record<string, unknown>)[field] ?? null);
  return IDENTITY_FIELDS[type].filter((field) => read(before, field) !== read(after, field));
}

function parseSourceConfig(type: SourceType, config: unknown): unknown {
  try {
    return parseConfig(type, config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ServiceError("validation", "The settings of the source are not valid.", fieldErrorsOf(error, "config"));
    }
    throw error;
  }
}

export async function updateSource(
  id: number,
  input: { name?: string; why?: string; owner?: string | null; checkIntervalMinutes?: number; config?: unknown },
  actor: Actor,
): Promise<void> {
  const data = parseOrThrow(updateSourceSchema, input);
  inImmediate(() => {
    const source = requireSource(id);
    const patch: Partial<typeof sources.$inferInsert> = { updatedAt: nowMs() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.why !== undefined) patch.why = data.why;
    if (data.owner !== undefined) patch.owner = data.owner;
    if (data.checkIntervalMinutes !== undefined && data.checkIntervalMinutes !== source.checkIntervalMinutes) {
      patch.checkIntervalMinutes = data.checkIntervalMinutes;
      // The new interval applies now, not after the old (maybe long) wait.
      patch.nextCheckAt = nowMs();
    }
    if (data.config !== undefined) {
      const next = parseSourceConfig(source.type, data.config);
      const before = parseSourceConfig(source.type, source.config);
      const changed = changedIdentityFields(source.type, before, next);
      if (changed.length > 0) {
        // §4.6: the identity (sources.key) never changes. A new identity is a new source.
        throw new ServiceError(
          "validation",
          `These fields identify the source and cannot change: ${changed.join(", ")}. Add a new source instead.`,
          Object.fromEntries(changed.map((field) => [`config.${field}`, "This field cannot change."])),
        );
      }
      patch.config = next;
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        // A new config deserves a fresh start: check it now, with no failure backoff.
        patch.nextCheckAt = nowMs();
        patch.consecutiveFailures = 0;
      }
    }
    getDb().update(sources).set(patch).where(eq(sources.id, id)).run();
    logActivity(actor, "source.update", "source", id, `Changed the settings of the source ${q(patch.name ?? source.name)}.`);
  });
}

/**
 * §5 "Deleting a source", in one transaction: the items, links, checks,
 * flags, and feed links go by cascade; the stories of its items get new
 * counts and a new primary item, or go when no item stays; the rank of the
 * stories that stay is recomputed (refreshStories).
 */
export async function deleteSource(id: number, actor: Actor): Promise<void> {
  inImmediate(() => {
    const source = requireSource(id);
    const storyIds = (
      getSqlite()
        .prepare("SELECT DISTINCT story_id AS id FROM items WHERE source_id = ? AND story_id IS NOT NULL")
        .all(id) as Array<{ id: number }>
    ).map((row) => row.id);
    getDb().delete(sources).where(eq(sources.id, id)).run();
    refreshStories(storyIds);
    logActivity(actor, "source.delete", "source", id, `Deleted the source ${q(source.name)} from the directory.`);
  });
}

export async function setPaused(id: number, paused: boolean, actor: Actor): Promise<void> {
  const value = parseOrThrow(z.boolean(), paused, "paused");
  inImmediate(() => {
    const source = requireSource(id);
    getDb().update(sources).set({ paused: value, updatedAt: nowMs() }).where(eq(sources.id, id)).run();
    logActivity(actor, value ? "source.pause" : "source.resume", "source", id, `${value ? "Paused" : "Resumed"} the source ${q(source.name)}.`);
  });
}

export async function requestCheck(id: number, actor: Actor): Promise<void> {
  inImmediate(() => {
    const source = requireSource(id);
    getDb().update(sources).set({ checkRequestedAt: nowMs() }).where(eq(sources.id, id)).run();
    logActivity(actor, "source.check", "source", id, `Asked for a check of the source ${q(source.name)} now.`);
  });
}

/**
 * Asks for a check of each source that is not paused. A source whose
 * connector needs a missing credential (as the worker sees it) is skipped:
 * no check can run for it. Returns the count.
 */
export async function requestCheckAllDue(actor: Actor): Promise<number> {
  const env = workerEnvView();
  return inImmediate(() => {
    const ids = getDb()
      .select({ id: sources.id, type: sources.type, config: sources.config })
      .from(sources)
      .where(eq(sources.paused, false))
      .all()
      .filter((source) => credentialNeeds(source.type, env, source.config) === null)
      .map((source) => source.id);
    const result =
      ids.length === 0 ? { changes: 0 } : getDb().update(sources).set({ checkRequestedAt: nowMs() }).where(inArray(sources.id, ids)).run();
    logActivity(actor, "source.check_all", "source", null, `Asked for a check of all ${result.changes} active sources now.`);
    return result.changes;
  });
}

export async function flagNoisy(id: number, note: string, actor: Actor): Promise<void> {
  const text = parseOrThrow(oneLineSchema, note ?? "", "note");
  inImmediate(() => {
    const source = requireSource(id);
    getDb()
      .insert(sourceFlags)
      .values({ sourceId: id, note: text, createdBy: actor.name.trim(), createdAt: nowMs() })
      .run();
    logActivity(actor, "source.flag", "source", id, `Flagged the source ${q(source.name)} as noisy${text ? `: ${text}` : "."}`);
  });
}

export async function resolveFlags(id: number, actor: Actor): Promise<void> {
  inImmediate(() => {
    const source = requireSource(id);
    const result = getDb()
      .update(sourceFlags)
      .set({ resolvedAt: nowMs(), resolvedBy: actor.name.trim() })
      .where(and(eq(sourceFlags.sourceId, id), isNull(sourceFlags.resolvedAt)))
      .run();
    logActivity(actor, "source.resolve_flags", "source", id, `Resolved ${result.changes} noisy flag(s) of the source ${q(source.name)}.`);
  });
}
