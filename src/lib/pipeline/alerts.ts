// Alerts (§9.3). Only a judge result creates one: never the re-judge, never the preview.
import { getSqlite } from "@/lib/db/client";
import { isQuietHours, quietHoursEnd } from "@/lib/schedule";
import { HOUR_MS } from "@/lib/time";
import type { AlertSettings, DigestSettings, QuietHours } from "@/lib/types";

import { parseJsonText } from "./rows";

/** A story older than this (by fresh_at) gets no alert. */
export const ALERT_MAX_AGE_MS = 48 * HOUR_MS;

export interface AlertCandidate {
  feedId: number;
  relevance: number;
  alert: boolean;
}

/**
 * Creates at most one alert for each feed and story when: alerts are on for
 * the feed, the result has alert = true, relevance >= alerts.minRelevance,
 * the judgement is visible (after the recompute), and the story is fresh
 * (fresh_at within 48 hours). Inside the quiet hours of the feed the alert
 * becomes visible when the quiet hours end. Call it inside the transaction
 * of the apply step, after the recompute.
 */
export function createAlerts(storyId: number, results: AlertCandidate[], now: number): number[] {
  const sqlite = getSqlite();
  const story = sqlite.prepare("SELECT fresh_at AS freshAt FROM stories WHERE id = ?").get(storyId) as
    | { freshAt: number }
    | undefined;
  if (!story || story.freshAt < now - ALERT_MAX_AGE_MS) return [];

  const feedRow = sqlite.prepare("SELECT alerts, quiet_hours, digest FROM feeds WHERE id = ? AND archived_at IS NULL");
  const hidden = sqlite.prepare("SELECT hidden_reason AS hidden FROM judgements WHERE feed_id = ? AND story_id = ?");
  const insert = sqlite.prepare(
    `INSERT INTO alerts (feed_id, story_id, created_at, visible_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (feed_id, story_id) DO NOTHING`,
  );

  const created: number[] = [];
  for (const result of results) {
    if (!result.alert) continue;
    const feed = feedRow.get(result.feedId) as { alerts: string; quiet_hours: string; digest: string } | undefined;
    if (!feed) continue;
    const alerts = parseJsonText(feed.alerts) as AlertSettings | null;
    if (!alerts?.enabled || result.relevance < alerts.minRelevance) continue;
    const judgement = hidden.get(result.feedId, storyId) as { hidden: string | null } | undefined;
    if (!judgement || judgement.hidden !== null) continue;

    const quiet = parseJsonText(feed.quiet_hours) as QuietHours | null;
    const timeZone = (parseJsonText(feed.digest) as DigestSettings | null)?.timeZone ?? "UTC";
    const visibleAt = quiet && isQuietHours(now, quiet, timeZone) ? quietHoursEnd(now, quiet, timeZone) : now;
    if (insert.run(result.feedId, storyId, now, visibleAt).changes > 0) created.push(result.feedId);
  }
  return created;
}
