// Server-side helper of the settings actions: the re-judge estimates that a
// page shows after a save of a judge-time setting (§4.8, §7.6).
// Server only (it calls the services); client components never import it.
import { estimateRejudge, listFeeds } from "@/lib/services";

import type { RejudgeEstimate } from "./helpers";

/**
 * The estimate for each given active feed (all active feeds when `feedIds`
 * is omitted), in the order of the feed tabs. `sourceId` limits the work
 * list to the stories of one source.
 */
export async function rejudgeEstimates(opts: { feedIds?: number[]; sourceId?: number } = {}): Promise<RejudgeEstimate[]> {
  const feeds = await listFeeds();
  const wanted = opts.feedIds ? new Set(opts.feedIds) : null;
  const out: RejudgeEstimate[] = [];
  for (const feed of feeds) {
    if (wanted && !wanted.has(feed.id)) continue;
    const calls = await estimateRejudge(feed.id, opts.sourceId === undefined ? undefined : { sourceId: opts.sourceId });
    out.push({ feedId: feed.id, feedName: feed.name, calls });
  }
  return out;
}
