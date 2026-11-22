// The activity log (specification §4.10, §18.2).
import { desc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { activity } from "@/lib/db/schema";
import { nowMs } from "@/lib/time";

import type { Actor, ActivityRow } from "./types";

const MAX_SUMMARY = 500;

/**
 * Writes one row of the activity log. Call it inside the transaction of the
 * change (it is synchronous and uses the connection of the process).
 */
export function logActivity(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: number | null,
  summary: string,
): void {
  getDb()
    .insert(activity)
    .values({
      at: nowMs(),
      actor: actor.name.slice(0, 120),
      action,
      entityType,
      entityId,
      summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary,
    })
    .run();
}

/** The most rows that one read returns. */
const MAX_ROWS = 500;

/** Newest first. Default: the last 100 rows. */
export async function listActivity(limit = 100): Promise<ActivityRow[]> {
  const n = Number.isInteger(limit) ? Math.min(MAX_ROWS, Math.max(1, limit)) : 100;
  return getDb()
    .select({
      at: activity.at,
      actor: activity.actor,
      action: activity.action,
      entityType: activity.entityType,
      entityId: activity.entityId,
      summary: activity.summary,
    })
    .from(activity)
    .orderBy(desc(activity.at), desc(activity.id))
    .limit(n)
    .all();
}
