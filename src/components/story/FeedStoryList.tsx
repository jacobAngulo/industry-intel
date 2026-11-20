"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState, type ReactNode } from "react";

import { HiddenLine, HiddenSlotContext, useUndoVote } from "./CardFrame";
import { addHiddenRow, mergeHiddenRows, removeHiddenRow, type HiddenRow } from "./hidden-rows";

export interface FeedStoryListItem {
  storyId: number;
  headline: string;
  /** The rendered card (a server component). */
  card: ReactNode;
}

/**
 * The ranked list of the feed page. It keeps the stories that this browser
 * hid in this page view (§4.3): when an automatic refresh (AutoRefresh)
 * removes a hidden story from the server list, its "Hidden for you. Undo"
 * line stays at its old position. A navigation or a reload clears the lines
 * (the page gives the list a new `key` for each view).
 */
export function FeedStoryList({ feedSlug, items }: { feedSlug: string; items: FeedStoryListItem[] }) {
  const [hidden, setHidden] = useState<HiddenRow[]>([]);
  const rows = mergeHiddenRows(items, hidden);

  return (
    <ol className="divide-y divide-border border-t border-border">
      {rows.map((row, index) =>
        row.kind === "story" ? (
          <li key={row.item.storyId} className="py-6">
            <HiddenSlotContext.Provider
              value={{
                hide: () =>
                  setHidden((list) => addHiddenRow(list, { storyId: row.item.storyId, headline: row.item.headline, index })),
                unhide: () => setHidden((list) => removeHiddenRow(list, row.item.storyId)),
              }}
            >
              {row.item.card}
            </HiddenSlotContext.Provider>
          </li>
        ) : (
          <li key={row.row.storyId} className="py-6">
            <GoneHiddenRow
              feedSlug={feedSlug}
              row={row.row}
              onRestored={() => setHidden((list) => removeHiddenRow(list, row.row.storyId))}
            />
          </li>
        ),
      )}
    </ol>
  );
}

/** The Undo line of a hidden story that the server list no longer has. Undo brings the card back. */
function GoneHiddenRow({ feedSlug, row, onRestored }: { feedSlug: string; row: HiddenRow; onRestored: () => void }) {
  const router = useRouter();
  const undoRef = useRef<HTMLButtonElement>(null);
  const { undo, pending, error } = useUndoVote(feedSlug, row.storyId, () => {
    // One transition: the line goes when the refreshed list with the story comes.
    startTransition(() => {
      onRestored();
      router.refresh();
    });
  });

  // The refresh removed the card and its Undo button: when the focus was on it, it is now on the body.
  useEffect(() => {
    if (document.activeElement === document.body) undoRef.current?.focus({ preventScroll: true });
  }, []);

  return <HiddenLine headline={row.headline} pending={pending} error={error} onUndo={undo} undoRef={undoRef} />;
}
