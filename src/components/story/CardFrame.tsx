"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode, type Ref } from "react";

import { voteAction } from "@/app/f/[slug]/actions";
import { Button, Icon } from "@/components/ui";

import { hidesForMe, type VoteState } from "./vote-state";

interface CardFrameValue {
  /** The newest vote state of this card in this page view (after an Undo, for example). */
  latest: VoteState | null;
  /** The feedback buttons call it after a saved vote. */
  onVoted: (state: VoteState) => void;
}

const CardFrameContext = createContext<CardFrameValue | null>(null);

/** The frame of the card around the feedback buttons, or null outside the main list. */
export function useCardFrame(): CardFrameValue | null {
  return useContext(CardFrameContext);
}

/**
 * The place of one card in the list (FeedStoryList). The card tells the list
 * when it collapses, so that the list keeps its Undo row after an automatic
 * refresh removes the story from the server list.
 */
export interface HiddenSlot {
  hide: () => void;
  unhide: () => void;
}

export const HiddenSlotContext = createContext<HiddenSlot | null>(null);

/** Removes this browser's vote of a story ("Undo"). `onUndone` gets the new vote state. */
export function useUndoVote(feedSlug: string, storyId: number, onUndone: (state: VoteState) => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const undo = () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await voteAction({ feedSlug, storyId, reason: null, from: "list" });
        if (result.ok) onUndone(result.data);
        else setError(result.message);
      } catch {
        setError("The vote was not removed. Check the connection and try again.");
      }
    });
  };
  return { undo, pending, error };
}

/** The one line "Hidden for you. Undo" of a collapsed card. */
export function HiddenLine({
  headline,
  pending,
  error,
  onUndo,
  undoRef,
}: {
  headline: string;
  pending: boolean;
  error: string | null;
  onUndo: () => void;
  undoRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm text-muted">
      <p role="status" className="flex min-w-0 items-center gap-2">
        <Icon name="hide" size={16} />
        <span>
          Hidden for you<span className="sr-only">: {headline}</span>.
        </span>
      </p>
      <Button ref={undoRef} size="sm" variant="ghost" icon="undo" pending={pending} onClick={onUndo}>
        Undo
      </Button>
      {error ? (
        <p role="alert" className="w-full text-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A story card of the main list (§4.3): after a vote of "Off topic" or "Too
 * basic" the card collapses to one line "Hidden for you. Undo" until the
 * next page load. Undo removes the vote. The list (FeedStoryList) keeps the
 * line when an automatic refresh removes the story.
 */
export function CardFrame({
  feedSlug,
  storyId,
  headline,
  children,
}: {
  feedSlug: string;
  storyId: number;
  headline: string;
  children: ReactNode;
}) {
  const slot = useContext(HiddenSlotContext);
  const [collapsed, setCollapsed] = useState(false);
  const [latest, setLatest] = useState<VoteState | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<"undo" | "body" | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "undo") undoRef.current?.focus();
    if (target === "body") bodyRef.current?.focus();
  }, [collapsed]);

  const value: CardFrameValue = {
    latest,
    onVoted: (state) => {
      setLatest(state);
      if (hidesForMe(state.myVote)) {
        focusNext.current = "undo";
        setCollapsed(true);
        slot?.hide();
      }
    },
  };

  const { undo, pending, error } = useUndoVote(feedSlug, storyId, (state) => {
    setLatest(state);
    focusNext.current = "body";
    setCollapsed(false);
    slot?.unhide();
  });

  if (collapsed) {
    return <HiddenLine headline={headline} pending={pending} error={error} onUndo={undo} undoRef={undoRef} />;
  }

  return (
    <CardFrameContext.Provider value={value}>
      <div ref={bodyRef} tabIndex={-1} className="outline-none">
        {children}
      </div>
    </CardFrameContext.Provider>
  );
}
