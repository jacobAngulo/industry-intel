// One source check (§7.1 step 2): the needs() test, the claim, the fetch, the
// storing of the items, and the bookkeeping.
import { createConnectorContext } from "@/lib/connectors/context";
import { getConnector } from "@/lib/connectors/registry";
import { ConnectorError, type Connector, type ConnectorContext, type FetchResult } from "@/lib/connectors/types";
import { getSqlite } from "@/lib/db/client";
import type { SourceDbRow } from "@/lib/db/schema";
import { HttpError } from "@/lib/http/types";
import { logEvent } from "@/lib/log";
import { DAY_MS, MINUTE_MS, nextUtcMidnight } from "@/lib/time";

import { readSource } from "./rows";
import { storeItems } from "./store";
import type { CheckSourceResult, PipelineDeps } from "./types";

export const CHECK_LOCK_MS = 5 * MINUTE_MS;
export const CHECK_TIMEOUT_MS = 4 * MINUTE_MS;
export const POLL_LIMIT = 30;
/** The source_checks rows kept for each source. */
export const CHECKS_KEPT = 50;
const MAX_BACKOFF_MS = DAY_MS;
const MAX_ERROR = 300;

const NOT_RUN: CheckSourceResult = { ran: false, ok: false, itemsFound: 0, itemsNew: 0 };

/**
 * The due sources, requested checks first, then the oldest next_check_at
 * (§7.1 step 2). The needs() test is in checkSource.
 */
export function dueSourceIds(limit: number, now: number): number[] {
  const rows = getSqlite()
    .prepare(
      `SELECT id FROM sources
        WHERE paused = 0
          AND (next_check_at <= @now OR check_requested_at IS NOT NULL)
          AND (locked_until IS NULL OR locked_until < @now)
        ORDER BY (check_requested_at IS NULL), check_requested_at, next_check_at, id
        LIMIT @limit`,
    )
    .all({ now, limit: Math.max(0, Math.floor(limit)) }) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** Clears check_requested_at only when the request is not newer than the start of this check. */
const CLEAR_REQUEST_SQL = `check_requested_at = CASE WHEN check_requested_at <= @start THEN NULL ELSE check_requested_at END`;

/** A source that needs a credential or setup: try again after one interval, with no check row. */
function postpone(source: SourceDbRow, now: number): void {
  getSqlite()
    .prepare(`UPDATE sources SET next_check_at = ?, check_requested_at = NULL WHERE id = ?`)
    .run(now + source.checkIntervalMinutes * MINUTE_MS, source.id);
}

/** Sets the 5-minute lock when the source is free. One IMMEDIATE transaction. */
function claim(sourceId: number, now: number): SourceDbRow | null {
  const sqlite = getSqlite();
  return sqlite
    .transaction(() => {
      const source = readSource(sourceId);
      if (!source || source.paused) return null;
      if (source.lockedUntil !== null && source.lockedUntil >= now) return null;
      sqlite.prepare("UPDATE sources SET locked_until = ? WHERE id = ?").run(now + CHECK_LOCK_MS, sourceId);
      return source;
    })
    .immediate();
}

async function fetchWithTimeout(
  connector: Connector,
  config: unknown,
  cursor: unknown,
  ctx: ConnectorContext,
  controller: AbortController,
): Promise<FetchResult<unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A connector that ignores the signal must not hold the check for ever.
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectorError("network", "The check took longer than 4 minutes and was stopped."));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([connector.fetch({ config, cursor, mode: "poll", limit: POLL_LIMIT, ctx }), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** A message that is fit to show in the UI. Connector errors are written for that. */
function errorMessage(error: unknown): string {
  if (error instanceof ConnectorError || error instanceof HttpError) return error.message.slice(0, MAX_ERROR);
  const detail = error instanceof Error ? error.message : "unknown error";
  return `The check failed: ${detail}`.slice(0, MAX_ERROR);
}

function jitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.9 + Math.random() * 0.2));
}

function insertCheck(row: { sourceId: number; start: number; finish: number; ok: boolean; found: number; added: number; error: string | null }): void {
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `INSERT INTO source_checks (source_id, started_at, finished_at, ok, items_found, items_new, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.sourceId, row.start, row.finish, row.ok ? 1 : 0, row.found, row.added, row.error);
  trimChecks(row.sourceId);
}

/** Keeps the newest CHECKS_KEPT rows of one source. */
export function trimChecks(sourceId: number): void {
  getSqlite()
    .prepare(
      `DELETE FROM source_checks WHERE source_id = @sourceId AND id NOT IN (
         SELECT id FROM source_checks WHERE source_id = @sourceId ORDER BY started_at DESC, id DESC LIMIT @keep)`,
    )
    .run({ sourceId, keep: CHECKS_KEPT });
}

function recordSuccess(sourceId: number, result: FetchResult<unknown>, start: number, now: number): CheckSourceResult {
  const sqlite = getSqlite();
  return sqlite
    .transaction(() => {
      const source = readSource(sourceId);
      if (!source) return { ...NOT_RUN, ran: true, error: "The source was deleted during the check." };
      const itemsNew = storeItems(source, result.items, now, source.lastSuccessAt === null);
      sqlite
        .prepare(
          `UPDATE sources
              SET cursor = @cursor, last_checked_at = @now, last_success_at = @now, last_error = NULL,
                  consecutive_failures = 0, next_check_at = @next, locked_until = NULL, ${CLEAR_REQUEST_SQL}
            WHERE id = @id`,
        )
        .run({
          id: sourceId,
          cursor: result.cursor === null ? null : JSON.stringify(result.cursor),
          now,
          next: now + jitter(source.checkIntervalMinutes * MINUTE_MS),
          start,
        });
      insertCheck({ sourceId, start, finish: now, ok: true, found: result.items.length, added: itemsNew, error: null });
      return { ran: true, ok: true, itemsFound: result.items.length, itemsNew };
    })
    .immediate();
}

function recordFailure(source: SourceDbRow, error: unknown, start: number, now: number): CheckSourceResult {
  const message = errorMessage(error);
  const budget = error instanceof ConnectorError && error.kind === "budget";
  const failures = budget ? source.consecutiveFailures : source.consecutiveFailures + 1;
  const intervalMs = source.checkIntervalMinutes * MINUTE_MS;
  const next = budget ? nextUtcMidnight(now) : now + Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);

  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      if (!readSource(source.id)) return;
      sqlite
        .prepare(
          `UPDATE sources
              SET last_checked_at = @now, last_error = @message, consecutive_failures = @failures,
                  next_check_at = @next, locked_until = NULL, ${CLEAR_REQUEST_SQL}
            WHERE id = @id`,
        )
        .run({ id: source.id, now, message, failures, next, start });
      insertCheck({ sourceId: source.id, start, finish: now, ok: false, found: 0, added: 0, error: message });
    })
    .immediate();

  if (!budget) {
    logEvent("warn", "source", `The check of source ${source.id} failed.`, {
      sourceId: source.id,
      type: source.type,
      kind: error instanceof ConnectorError || error instanceof HttpError ? error.kind : "error",
      error: message,
      failures,
    });
  }
  return { ran: true, ok: false, itemsFound: 0, itemsNew: 0, error: message };
}

/** One source check: needs() test, claim, fetch, store, bookkeeping (§7.1 step 2, §7.2). */
export async function checkSource(sourceId: number, deps: PipelineDeps): Promise<CheckSourceResult> {
  const start = deps.now();
  const source = readSource(sourceId);
  if (!source || source.paused) return NOT_RUN;

  const connector = getConnector(source.type);
  const controller = new AbortController();
  const ctx = createConnectorContext({
    http: deps.http,
    search: deps.search,
    mail: deps.mail,
    now: deps.now,
    signal: controller.signal,
  });
  const config = connector.configSchema.safeParse(source.config);
  if (config.success && connector.needs(ctx.env, config.data) !== null) {
    postpone(source, start);
    return NOT_RUN;
  }

  const claimed = claim(sourceId, start);
  if (!claimed) return NOT_RUN;
  if (!config.success) {
    return recordFailure(claimed, new Error("the settings of this source are not valid"), start, deps.now());
  }

  try {
    const result = await fetchWithTimeout(connector, config.data, claimed.cursor ?? null, ctx, controller);
    return recordSuccess(sourceId, result, start, deps.now());
  } catch (error) {
    return recordFailure(claimed, error, start, deps.now());
  }
}
