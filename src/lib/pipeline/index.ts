// The pipeline (specification §7): source checks, storing items, the judge
// call and its apply step, alerts, analyses, re-judge, and housekeeping.
// The worker folder has only the loop; it calls these functions.

// The shared job helpers (model gate, worker state, re-judge requests,
// backfill, story refresh). The services use them too. Keep these re-exports.
export {
  BACKFILL_MAX_ITEMS,
  BACKFILL_MAX_STORIES,
  HEARTBEAT_ALIVE_MS,
  REJUDGE_DEFAULT_SINCE_MS,
  WORKER_STATE_KEYS,
  backfillFeedSource,
  clearLlmPause,
  createRejudgeRequest,
  deleteWorkerState,
  estimateRejudgeCount,
  isWorkerAlive,
  latestRejudgeRequest,
  modelGate,
  orphanStoryIds,
  readHeartbeat,
  readLlmPause,
  readWorkerState,
  refreshStories,
  rejudgeWorkStoryIds,
  setLlmPause,
  writeWorkerState,
  type LlmPauseState,
  type ModelGate,
  type RejudgeScope,
} from "./jobs";

export type { CheckSourceResult, DraftJudgement, JudgeOutcome, PipelineDeps } from "./types";

/** One source check: needs() test, claim, fetch, store, bookkeeping (§7.1 step 2, §7.2). */
export { checkSource, dueSourceIds } from "./check";
/** Claims up to `limit` pending items that are safe to judge now (§7.3 claim rules). */
export { claimItemsToJudge } from "./claim";
/** The link join of §7.2 (also used before the call and in the apply step). */
export { findLinkJoin, type LinkJoin } from "./links";
/** judgeItem: the judge call and the apply step (§7.3, §7.4). judgeDraft: the preview judge (no write). */
export { judgeDraft, judgeItem } from "./judge";
/** The deeper analysis (§7.5). True when it did work. */
export { runNextAnalysis } from "./analysis";
/** One story of one re-judge request (§7.6). */
export { runRejudgeStep } from "./rejudge";
/** §7.1 step 7. */
export { housekeeping } from "./housekeeping";
