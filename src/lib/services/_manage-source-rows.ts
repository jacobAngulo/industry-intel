// The derived view of sources: status (§10.2), hints (§10.3), feeds, and the
// statistics of §4.5 / §4.6 / §8.5. listSources, getSource, and
// listFeedSources share it.
import { credentialNeeds } from "@/lib/connectors/configs";
import { getSqlite } from "@/lib/db/client";
import type { SourceDbRow } from "@/lib/db/schema";
import { getEnv, type Env, type EnvName } from "@/lib/env";
import { readHeartbeat } from "@/lib/pipeline/jobs";
import { DAY_MS, nowMs } from "@/lib/time";
import type { WorkerHeartbeat } from "@/lib/types";

import { formatUtc } from "./_manage-db";
import type { SourceRow, SourceStatus } from "./types";

/** The period of the source statistics (§4.6, §10.3). */
export const STATS_WINDOW_MS = 30 * DAY_MS;
/** §10.3 "Low signal": at least this many judged items in 30 days … */
export const LOW_SIGNAL_MIN_JUDGED = 20;
/** … and fewer than this share shown in any feed. */
export const LOW_SIGNAL_RATE = 0.05;
/** §10.2: this many failures in a row give the status "Failing". */
export const FAILING_AFTER = 3;

export const LOW_SIGNAL_HINT = "Low signal: consider a narrower filter, or pause this source.";
export const NOT_IN_FEED_HINT = "Not in any feed: its items are not judged.";

const MAILBOX_VARS: readonly EnvName[] = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"];

/**
 * The environment as the worker sees it (§13): the worker checks the
 * sources, so its heartbeat decides whether a key is present. With no
 * heartbeat yet, the environment of this process decides.
 */
export function workerEnvView(env: Env = getEnv(), beat: WorkerHeartbeat | null = readHeartbeat()): Env {
  if (!beat) return env;
  const has = (name: EnvName): boolean => {
    if (name === "X_BEARER_TOKEN") return beat.hasXToken;
    if (name === "OLLAMA_API_KEY") return beat.hasModelKey;
    if (MAILBOX_VARS.includes(name)) return beat.hasMailbox;
    return env.has(name);
  };
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "has") return has;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface SourceStats {
  itemsFetched: number;
  itemsJudged: number;
  /** Judged items (30 days) whose story is visible in an active feed. */
  itemsShown: number;
  storiesShown: number;
  usefulStories: number;
  openFlags: number;
  flaggers: number;
  failingSince: number | null;
}

const EMPTY_STATS: SourceStats = {
  itemsFetched: 0,
  itemsJudged: 0,
  itemsShown: 0,
  storiesShown: 0,
  usefulStories: 0,
  openFlags: 0,
  flaggers: 0,
  failingSince: null,
};

/** A story counts as shown when it has a visible judgement in an active feed. */
const SHOWN_STORY = `EXISTS (SELECT 1 FROM judgements j JOIN feeds f ON f.id = j.feed_id
  WHERE j.story_id = i.story_id AND j.hidden_reason IS NULL AND f.archived_at IS NULL)`;

/** §8.5: a story is useful in a feed when its useful votes outnumber off_topic + too_basic. */
const USEFUL_STORY_IDS = `SELECT story_id FROM feedback GROUP BY feed_id, story_id
  HAVING SUM(reason = 'useful') > SUM(reason IN ('off_topic', 'too_basic'))`;

/** The statistics of each source (or of one source). */
export function sourceStats(now: number, sourceId: number | null = null): Map<number, SourceStats> {
  const sqlite = getSqlite();
  const params = { since: now - STATS_WINDOW_MS, id: sourceId };
  const result = new Map<number, SourceStats>();
  const entry = (id: number): SourceStats => {
    let stats = result.get(id);
    if (!stats) result.set(id, (stats = { ...EMPTY_STATS }));
    return stats;
  };

  const items = sqlite
    .prepare(
      `SELECT i.source_id AS id, COUNT(*) AS fetched,
              SUM(i.judge_status = 'judged') AS judged,
              SUM(i.judge_status = 'judged' AND i.story_id IS NOT NULL AND ${SHOWN_STORY}) AS shown,
              COUNT(DISTINCT CASE WHEN i.story_id IS NOT NULL AND ${SHOWN_STORY} THEN i.story_id END) AS stories
         FROM items i
        WHERE i.fetched_at >= @since AND (@id IS NULL OR i.source_id = @id)
        GROUP BY i.source_id`,
    )
    .all(params) as Array<{ id: number; fetched: number; judged: number; shown: number; stories: number }>;
  for (const row of items) {
    Object.assign(entry(row.id), {
      itemsFetched: row.fetched,
      itemsJudged: row.judged ?? 0,
      itemsShown: row.shown ?? 0,
      storiesShown: row.stories,
    });
  }

  const useful = sqlite
    .prepare(
      `SELECT i.source_id AS id, COUNT(DISTINCT i.story_id) AS n FROM items i
        WHERE i.story_id IN (${USEFUL_STORY_IDS}) AND (@id IS NULL OR i.source_id = @id)
        GROUP BY i.source_id`,
    )
    .all({ id: sourceId }) as Array<{ id: number; n: number }>;
  for (const row of useful) entry(row.id).usefulStories = row.n;

  const flags = sqlite
    .prepare(
      `SELECT source_id AS id, COUNT(*) AS n, COUNT(DISTINCT lower(created_by)) AS people FROM source_flags
        WHERE resolved_at IS NULL AND (@id IS NULL OR source_id = @id) GROUP BY source_id`,
    )
    .all({ id: sourceId }) as Array<{ id: number; n: number; people: number }>;
  for (const row of flags) Object.assign(entry(row.id), { openFlags: row.n, flaggers: row.people });

  const failing = sqlite
    .prepare(
      `SELECT c.source_id AS id, MIN(c.started_at) AS since FROM source_checks c JOIN sources s ON s.id = c.source_id
        WHERE c.ok = 0 AND c.started_at > COALESCE(s.last_success_at, 0) AND (@id IS NULL OR c.source_id = @id)
        GROUP BY c.source_id`,
    )
    .all({ id: sourceId }) as Array<{ id: number; since: number }>;
  for (const row of failing) entry(row.id).failingSince = row.since;

  return result;
}

/** shown ÷ judged (§4.6), or null when nothing was judged. */
export function signalRateOf(stats: SourceStats): number | null {
  return stats.itemsJudged > 0 ? Math.min(1, stats.itemsShown / stats.itemsJudged) : null;
}

/** The status badge (§10.2, first match wins) and its detail line. */
export function deriveStatus(source: SourceDbRow, env: Env): { status: SourceStatus; detail: string | null } {
  if (source.paused) return { status: "paused", detail: null };
  const need = credentialNeeds(source.type, env, source.config);
  if (need) return { status: need.code === "x_token" ? "needs_token" : "needs_setup", detail: need.message };
  if (source.consecutiveFailures >= FAILING_AFTER) return { status: "failing", detail: source.lastError };
  // A success clears last_error, so a set last_error means that the last check failed.
  if (source.lastCheckedAt === null) return { status: "waiting", detail: source.lastError };
  return { status: "active", detail: source.lastError };
}

/** An error text with no final full stop, for a hint sentence. */
function errorClause(error: string | null): string {
  return (error ?? "unknown error").trim().replace(/[.\s]+$/, "");
}

/** The hints of §10.3, in a fixed order. */
export function hintsFor(source: SourceDbRow, status: SourceStatus, stats: SourceStats, feedCount: number): string[] {
  const hints: string[] = [];
  const rate = signalRateOf(stats);
  if (stats.itemsJudged >= LOW_SIGNAL_MIN_JUDGED && rate !== null && rate < LOW_SIGNAL_RATE) hints.push(LOW_SIGNAL_HINT);
  if (stats.openFlags >= 1) {
    const people = Math.max(1, stats.flaggers);
    hints.push(`Flagged as noisy by ${people} ${people === 1 ? "person" : "people"}.`);
  }
  if (status === "failing") {
    const since = stats.failingSince ?? source.lastCheckedAt ?? source.updatedAt;
    hints.push(`Failing since ${formatUtc(since)}: ${errorClause(source.lastError)}. Next try: ${formatUtc(source.nextCheckAt)}.`);
  } else if (status !== "paused" && source.lastError !== null) {
    // A person sees a failed check at once, also before the third failure (and for a budget error, which does not count).
    hints.push(`The last check failed: ${errorClause(source.lastError)}. Next try: ${formatUtc(source.nextCheckAt)}.`);
  }
  if (feedCount === 0) hints.push(NOT_IN_FEED_HINT);
  return hints;
}

type FeedChip = { id: number; slug: string; name: string };

/** The active feeds of each source, in feed position order. */
export function feedsBySource(sourceId: number | null = null): Map<number, FeedChip[]> {
  const rows = getSqlite()
    .prepare(
      `SELECT fs.source_id AS sourceId, f.id, f.slug, f.name FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
        WHERE f.archived_at IS NULL AND (@id IS NULL OR fs.source_id = @id)
        ORDER BY f.position, f.id`,
    )
    .all({ id: sourceId }) as Array<FeedChip & { sourceId: number }>;
  const result = new Map<number, FeedChip[]>();
  for (const { sourceId: id, ...feed } of rows) {
    const list = result.get(id) ?? [];
    list.push(feed);
    result.set(id, list);
  }
  return result;
}

/** Builds the SourceRow of each given source. */
export function toSourceRows(rows: SourceDbRow[], opts: { now?: number; env?: Env; oneId?: number } = {}): SourceRow[] {
  const now = opts.now ?? nowMs();
  const env = opts.env ?? workerEnvView();
  const stats = sourceStats(now, opts.oneId ?? null);
  const feeds = feedsBySource(opts.oneId ?? null);
  return rows.map((source) => {
    const s = stats.get(source.id) ?? EMPTY_STATS;
    const sourceFeeds = feeds.get(source.id) ?? [];
    const { status, detail } = deriveStatus(source, env);
    return {
      id: source.id,
      type: source.type,
      name: source.name,
      url: source.url,
      status,
      statusDetail: detail,
      feeds: sourceFeeds,
      lastSuccessAt: source.lastSuccessAt,
      usefulStories: s.usefulStories,
      signalRate: signalRateOf(s),
      openFlags: s.openFlags,
      addedBy: source.addedBy,
      owner: source.owner,
      hints: hintsFor(source, status, s, sourceFeeds.length),
    };
  });
}
