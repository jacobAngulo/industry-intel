// The local vote state of the feedback buttons (specification §4.3). Pure, so
// the optimistic update has tests.
import { FEEDBACK_REASONS, type FeedbackReason } from "@/lib/types";

export interface VoteState {
  votes: Record<FeedbackReason, number>;
  myVote: FeedbackReason | null;
}

/** The vote to send for a click: the active reason again removes the vote (null). */
export function nextVote(current: FeedbackReason | null, clicked: FeedbackReason): FeedbackReason | null {
  return current === clicked ? null : clicked;
}

/** The state after this browser's vote changes to `next` (counts stay at 0 or more). */
export function applyVote(state: VoteState, next: FeedbackReason | null): VoteState {
  const votes = { ...state.votes };
  if (state.myVote !== null) votes[state.myVote] = Math.max(0, (votes[state.myVote] ?? 0) - 1);
  if (next !== null) votes[next] = (votes[next] ?? 0) + 1;
  return { votes, myVote: next };
}

/** True when a vote hides the story for this browser in the main list (§8.1). */
export function hidesForMe(reason: FeedbackReason | null): boolean {
  return reason === "off_topic" || reason === "too_basic";
}

/** True when two states are the same. */
export function sameVoteState(a: VoteState, b: VoteState): boolean {
  return a.myVote === b.myVote && FEEDBACK_REASONS.every((reason) => a.votes[reason] === b.votes[reason]);
}
