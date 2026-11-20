import { describe, expect, it } from "vitest";

import { addHiddenRow, alertsToDismissAfterVote, mergeHiddenRows, removeHiddenRow, type HiddenRow } from "./hidden-rows";

const items = (ids: number[]) => ids.map((storyId) => ({ storyId }));
const ids = (rows: ReturnType<typeof mergeHiddenRows<{ storyId: number }>>) =>
  rows.map((row) => (row.kind === "story" ? row.item.storyId : `hidden ${row.row.storyId}`));

describe("mergeHiddenRows", () => {
  it("keeps the server order when no hidden story left the list", () => {
    const hidden: HiddenRow[] = [{ storyId: 2, headline: "B", index: 1 }];
    expect(ids(mergeHiddenRows(items([1, 2, 3]), hidden))).toEqual([1, 2, 3]);
  });

  it("puts the Undo row of a story that left the list (refresh) at its old position", () => {
    const hidden: HiddenRow[] = [{ storyId: 2, headline: "B", index: 1 }];
    expect(ids(mergeHiddenRows(items([1, 3, 4]), hidden))).toEqual([1, "hidden 2", 3, 4]);
  });

  it("puts several rows back in the order of their positions, and a row past the end at the end", () => {
    const hidden: HiddenRow[] = [
      { storyId: 3, headline: "C", index: 2 },
      { storyId: 2, headline: "B", index: 1 },
      { storyId: 9, headline: "I", index: 40 },
    ];
    expect(ids(mergeHiddenRows(items([1, 4]), hidden))).toEqual([1, "hidden 2", "hidden 3", 4, "hidden 9"]);
  });
});

describe("addHiddenRow / removeHiddenRow", () => {
  it("keeps one row for each story", () => {
    let list = addHiddenRow([], { storyId: 2, headline: "B", index: 1 });
    list = addHiddenRow(list, { storyId: 2, headline: "B", index: 3 });
    expect(list).toEqual([{ storyId: 2, headline: "B", index: 3 }]);
    expect(removeHiddenRow(list, 2)).toEqual([]);
    expect(removeHiddenRow(list, 5)).toBe(list);
  });
});

describe("alertsToDismissAfterVote", () => {
  it("dismisses the alert of the story after a vote that hides it for this browser", () => {
    expect(alertsToDismissAfterVote(7, "off_topic")).toEqual([7]);
    expect(alertsToDismissAfterVote(7, "too_basic")).toEqual([7]);
  });
  it("keeps the alert after another vote, a removed vote, or with no alert", () => {
    expect(alertsToDismissAfterVote(7, "useful")).toEqual([]);
    expect(alertsToDismissAfterVote(7, null)).toEqual([]);
    expect(alertsToDismissAfterVote(null, "off_topic")).toEqual([]);
  });
});
