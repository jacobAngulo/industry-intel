// The request for the deeper analysis (specification §4.2, §7.5; §18.2
// analyses.ts). The worker writes the analysis (runNextAnalysis).
//
// Decision: a request on a `done` or `failed` row ("Write again" / "Try
// again") puts the row back to `queued` with attempts 0 and no error, and
// keeps the old content and model until the worker writes the new ones, so
// the page can still show the old analysis under the progress line. A
// request on a `queued` or `running` row changes nothing.
import { getSqlite } from "@/lib/db/client";
import { nowMs } from "@/lib/time";

import { ServiceError, hasJudgement, loadFeedFacts, readAnalysisView } from "./_read-shared";
import type { Actor, AnalysisView } from "./types";

// No activity row: the activity log holds changes to sources, feeds, and
// shared settings (§3); the row keeps who asked (requested_by).
function queueAnalysis(feedId: number, storyId: number, requestedBy: string, now: number): void {
  const sqlite = getSqlite();
  const row = sqlite.prepare("SELECT id, status FROM analyses WHERE feed_id = ? AND story_id = ?").get(feedId, storyId) as
    | { id: number; status: string }
    | undefined;
  if (!row) {
    sqlite
      .prepare(
        `INSERT INTO analyses (feed_id, story_id, status, attempts, requested_by, requested_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(feedId, storyId, requestedBy, now, now);
    return;
  }
  if (row.status === "queued" || row.status === "running") return;
  sqlite
    .prepare(
      `UPDATE analyses
          SET status = 'queued', stage = NULL, error = NULL, attempts = 0, requested_by = ?, requested_at = ?,
              started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(requestedBy, now, now, row.id);
}

/** Queues the analysis of a story in a feed and returns its view. */
export async function requestAnalysis(feedId: number, storyId: number, actor: Actor): Promise<AnalysisView> {
  const name = actor.name;
  const feed = loadFeedFacts(feedId);
  if (!feed) throw new ServiceError("not_found", "This feed does not exist.");

  return getSqlite()
    .transaction(() => {
      if (!hasJudgement(feedId, storyId)) throw new ServiceError("not_found", "This story is not in this feed.");
      queueAnalysis(feedId, storyId, name, nowMs());
      const view = readAnalysisView(feed, storyId);
      if (!view) throw new ServiceError("not_found", "The analysis was not stored.");
      return view;
    })
    .immediate();
}
