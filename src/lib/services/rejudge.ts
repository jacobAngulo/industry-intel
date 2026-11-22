// Re-judge requests (specification §7.6, §18.2). The work list and the
// request rules live in src/lib/pipeline/jobs.ts, shared with the worker.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { sources, type RejudgeRequestDbRow } from "@/lib/db/schema";
import { createRejudgeRequest, estimateRejudgeCount, latestRejudgeRequest } from "@/lib/pipeline/jobs";

import { inImmediate, q, requireFeed } from "./_manage-db";
import { notFound, parseOrThrow, ServiceError } from "./_manage-errors";
import { idSchema } from "./_manage-schemas";
import { logActivity } from "./activity";
import type { Actor, RejudgeProgress } from "./types";

/** At most this many stories in one request (a cost bound on the model calls). */
const MAX_STORIES_CAP = 5000;

function toProgress(row: RejudgeRequestDbRow): RejudgeProgress {
  return { id: row.id, feedId: row.feedId, status: row.status, total: row.total, done: row.done, failed: row.failed };
}

/** The count of the work list (the number of model calls). 0 for an unknown feed. */
export async function estimateRejudge(feedId: number, opts?: { sourceId?: number }): Promise<number> {
  if (!Number.isInteger(feedId)) return 0;
  return estimateRejudgeCount(feedId, { sourceId: opts?.sourceId ?? null });
}

const requestSchema = z.object({
  sourceId: idSchema.optional(),
  maxStories: z.number().int().min(1).max(MAX_STORIES_CAP).optional(),
});

/** Returns the open request of the same feed and source, or a new one (§7.6). */
export async function requestRejudge(
  feedId: number,
  opts: { sourceId?: number; maxStories?: number },
  actor: Actor,
): Promise<RejudgeProgress> {
  const data = parseOrThrow(requestSchema, opts ?? {});
  return inImmediate(() => {
    const feed = requireFeed(feedId);
    if (feed.archivedAt !== null) throw new ServiceError("conflict", "The feed is archived. Restore it first.");
    let sourceName: string | null = null;
    if (data.sourceId !== undefined) {
      const source = getDb().select({ name: sources.name }).from(sources).where(eq(sources.id, data.sourceId)).get();
      if (!source) throw notFound("The source");
      sourceName = source.name;
    }
    const { request, created } = createRejudgeRequest({
      feedId,
      sourceId: data.sourceId ?? null,
      maxStories: data.maxStories ?? null,
      requestedBy: actor.name.trim(),
    });
    const scope = sourceName === null ? "" : ` for the source ${q(sourceName)}`;
    logActivity(
      actor,
      "feed.rejudge",
      "feed",
      feedId,
      `${created ? "Asked for" : "Extended"} a re-judge of the feed ${q(feed.name)}${scope} (${request.total} stories).`,
    );
    return toProgress(request);
  });
}

/** The newest request of the feed. */
export async function rejudgeProgress(feedId: number): Promise<RejudgeProgress | null> {
  if (!Number.isInteger(feedId)) return null;
  const row = latestRejudgeRequest(feedId);
  return row ? toProgress(row) : null;
}
