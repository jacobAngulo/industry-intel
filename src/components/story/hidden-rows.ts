// The "Hidden for you. Undo" rows of the main list (specification §4.3). A
// negative vote collapses a card; the automatic refresh then gives a list
// without that story. The list keeps the collapsed stories of this page view
// in client state and puts their Undo rows back at their old positions, until
// a navigation or a reload. Pure, so the rules have tests.
import type { FeedbackReason } from "@/lib/types";

import { hidesForMe } from "./vote-state";

export interface HiddenRow {
  storyId: number;
  headline: string;
  /** The position of the row in the shown list when the person hid it. */
  index: number;
}

export type ListRow<T> = { kind: "story"; item: T } | { kind: "hidden"; row: HiddenRow };

/**
 * The rows to show: the stories of the server list in their order, plus an
 * Undo row for each hidden story that is no longer in the server list, at its
 * old position (or at the end).
 */
export function mergeHiddenRows<T extends { storyId: number }>(
  items: readonly T[],
  hidden: readonly HiddenRow[],
): ListRow<T>[] {
  const present = new Set(items.map((item) => item.storyId));
  const rows: ListRow<T>[] = items.map((item) => ({ kind: "story", item }));
  const gone = hidden.filter((row) => !present.has(row.storyId)).sort((a, b) => a.index - b.index);
  for (const row of gone) rows.splice(Math.min(Math.max(0, row.index), rows.length), 0, { kind: "hidden", row });
  return rows;
}

/** Adds (or moves) the row of one story. */
export function addHiddenRow(list: readonly HiddenRow[], row: HiddenRow): HiddenRow[] {
  return [...list.filter((r) => r.storyId !== row.storyId), row];
}

/** Removes the row of one story (the same list when it has none). */
export function removeHiddenRow(list: readonly HiddenRow[], storyId: number): HiddenRow[] {
  return list.some((r) => r.storyId === storyId) ? list.filter((r) => r.storyId !== storyId) : (list as HiddenRow[]);
}

/**
 * The alerts to dismiss in this browser after a saved vote (§9.3): the alert
 * of the story when the vote hides the story for this browser. The story then
 * leaves the list, and with it the Dismiss button of its alert.
 */
export function alertsToDismissAfterVote(alertId: number | null | undefined, myVote: FeedbackReason | null): number[] {
  return alertId != null && hidesForMe(myVote) ? [alertId] : [];
}
