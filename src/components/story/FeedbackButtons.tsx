"use client";

import { useOptimistic, useState, useTransition } from "react";

import { voteAction } from "@/app/f/[slug]/actions";
import { dismissAlerts } from "@/components/nav/dismissed-alerts";
import { ChipToggle } from "@/components/ui";
import { FEEDBACK_REASONS, FEEDBACK_REASON_LABELS, type FeedbackReason } from "@/lib/types";

import { useCardFrame } from "./CardFrame";
import { alertsToDismissAfterVote } from "./hidden-rows";
import { applyVote, nextVote, sameVoteState, type VoteState } from "./vote-state";

export interface FeedbackButtonsProps {
  feedSlug: string;
  storyId: number;
  votes: Record<FeedbackReason, number>;
  myVote: FeedbackReason | null;
  /** Where the buttons are: the main list, the filtered list, or the story page. */
  from: "list" | "filtered" | "story";
  /** The shown alert of the story: a vote that hides the story dismisses it in this browser (§9.3). */
  alertId?: number | null;
}

/**
 * The four feedback buttons of §4.3: Useful · Too basic · Off topic · Already
 * knew this. One vote for each browser; a click on the active reason removes
 * it. The counts update at once (optimistic) and then from the server.
 */
export function FeedbackButtons({ feedSlug, storyId, votes, myVote, from, alertId = null }: FeedbackButtonsProps) {
  const frame = useCardFrame();
  const fromServer: VoteState = { votes, myVote };
  const [state, setState] = useState<VoteState>(frame?.latest ?? fromServer);
  const [serverSeen, setServerSeen] = useState<VoteState>(fromServer);
  // New data from the server (a refresh) replaces the local state.
  if (!sameVoteState(serverSeen, fromServer)) {
    setServerSeen(fromServer);
    setState(fromServer);
  }
  const [shown, showVote] = useOptimistic(state, applyVote);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const click = (reason: FeedbackReason) => {
    if (pending) return;
    const next = nextVote(shown.myVote, reason);
    setError(null);
    setSaved(null);
    startTransition(async () => {
      showVote(next);
      try {
        const result = await voteAction({ feedSlug, storyId, reason: next, from });
        if (result.ok) {
          const dismiss = alertsToDismissAfterVote(alertId, result.data.myVote);
          if (dismiss.length > 0) dismissAlerts(dismiss);
          setState(result.data);
          setSaved(
            result.data.myVote
              ? `Your vote: ${FEEDBACK_REASON_LABELS[result.data.myVote]}.${from === "filtered" ? " The lists change on the next page load." : ""}`
              : "Your vote is removed.",
          );
          frame?.onVoted(result.data);
        } else {
          setError(result.message);
        }
      } catch {
        setError("The vote was not saved. Check the connection and try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="Feedback on this story" className="flex flex-wrap gap-1.5">
        {FEEDBACK_REASONS.map((reason) => {
          const count = shown.votes[reason] ?? 0;
          return (
            <ChipToggle key={reason} pressed={shown.myVote === reason} onClick={() => click(reason)}>
              {FEEDBACK_REASON_LABELS[reason]}
              {count > 0 ? (
                <span className="tabular-nums text-muted">
                  <span className="sr-only">, votes: </span>
                  {count}
                </span>
              ) : null}
            </ChipToggle>
          );
        })}
      </div>
      <p role="status" aria-live="polite" className={from === "filtered" && saved ? "text-sm text-muted" : "sr-only"}>
        {saved}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
