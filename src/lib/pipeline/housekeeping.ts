// The hourly housekeeping of the worker (§7.1 step 7).
import { getSqlite } from "@/lib/db/client";
import { MINUTE_MS } from "@/lib/time";

import { CHECKS_KEPT } from "./check";
import { orphanStoryIds, readLlmPause, refreshStories } from "./jobs";

export const EVENTS_KEPT = 2000;
/** A running job with no progress for this long is put back in the queue. */
export const STALE_JOB_MS = 15 * MINUTE_MS;

export function housekeeping(now: number): void {
  const sqlite = getSqlite();
  sqlite.prepare(`DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC, id DESC LIMIT ?)`).run(EVENTS_KEPT);
  sqlite
    .prepare(
      `DELETE FROM source_checks WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY started_at DESC, id DESC) AS n FROM source_checks)
         WHERE n > ?)`,
    )
    .run(CHECKS_KEPT);
  refreshStories(orphanStoryIds(), now);

  const staleBefore = now - STALE_JOB_MS;
  sqlite
    .prepare(`UPDATE analyses SET status = 'queued', stage = NULL, updated_at = ? WHERE status = 'running' AND updated_at < ?`)
    .run(now, staleBefore);
  // While the model is paused a running request has no progress on purpose: it keeps its place.
  const pause = readLlmPause();
  if (pause.pausedUntil === null || pause.pausedUntil <= now) {
    sqlite
      .prepare(`UPDATE rejudge_requests SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ?`)
      .run(now, staleBefore);
  }
}
