import { describe, expect, it } from "vitest";

import {
  analysisStepIndex,
  countLabel,
  decayLine,
  formatScore,
  formatSigned,
  hiddenReasonText,
  hostOf,
  safeHttpUrl,
  sourceNames,
  stringList,
} from "./format";
import { applyVote, hidesForMe, nextVote, sameVoteState, type VoteState } from "./vote-state";

describe("safeHttpUrl", () => {
  it("keeps http and https addresses", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  it("refuses other schemes, relative and bad addresses", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "/f/a", "", null, undefined, "not a url"]) {
      expect(safeHttpUrl(url)).toBeNull();
    }
  });

  it("gives the host without www", () => {
    expect(hostOf("https://www.example.com/x")).toBe("example.com");
  });
});

describe("scores and the decay line", () => {
  it("formats a score with at most one decimal", () => {
    expect(formatScore(8)).toBe("8");
    expect(formatScore(6.66)).toBe("6.7");
    expect(formatScore(Number.NaN)).toBe("0");
  });

  it("formats a signed rank part", () => {
    expect(formatSigned(8)).toBe("+8");
    expect(formatSigned(-6.7)).toBe("−6.7");
    expect(formatSigned(0)).toBe("0");
    expect(formatSigned(0.01)).toBe("0");
  });

  it("writes the decay line of §8.3", () => {
    expect(decayLine({ ageHours: 20.2, halfLifeHours: 144, factor: 0.9083 })).toBe(
      "20 h old, effective half-life 144 h: × 0.91",
    );
    expect(decayLine({ ageHours: 0.3, halfLifeHours: 48, factor: 0.996 })).toBe(
      "less than 1 h old, effective half-life 48 h: × 1.00",
    );
  });
});

describe("sourceNames", () => {
  it("shows the first two and counts the rest", () => {
    const sources = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }];
    expect(sourceNames(sources)).toEqual({ shown: [{ name: "A" }, { name: "B" }], more: 2 });
    expect(sourceNames([{ name: "A" }])).toEqual({ shown: [{ name: "A" }], more: 0 });
  });
});

describe("hiddenReasonText", () => {
  it("says each hidden reason in words", () => {
    expect(hiddenReasonText("my_vote", null)).toBe("Your vote");
    expect(hiddenReasonText("exclusion", "Beginner tutorials")).toBe("Exclusion: “Beginner tutorials”");
    expect(hiddenReasonText("exclusion", "source filter")).toBe("Exclusion: the Ignore text of a source");
    expect(hiddenReasonText("exclusion", null)).toBe("Exclusion");
    expect(hiddenReasonText("below_threshold", null)).toBe("Below the minimum relevance");
    expect(hiddenReasonText("feedback", null)).toBe("Team feedback");
    expect(hiddenReasonText("source_removed", null)).toBe("No source of this feed");
  });
});

describe("small helpers", () => {
  it("finds the analysis step", () => {
    expect(analysisStepIndex("queued", null)).toBe(0);
    expect(analysisStepIndex("running", "Reading the sources")).toBe(1);
    expect(analysisStepIndex("running", "Writing")).toBe(2);
    expect(analysisStepIndex("running", null)).toBe(1);
  });

  it("counts with the right noun", () => {
    expect(countLabel(1, "story", "stories")).toBe("1 story");
    expect(countLabel(0, "story", "stories")).toBe("0 stories");
  });

  it("keeps only non-empty strings of a list", () => {
    expect(stringList(["a", 1, "", " ", "b", null])).toEqual(["a", "b"]);
    expect(stringList("a")).toEqual([]);
  });
});

describe("vote state", () => {
  const base: VoteState = { votes: { useful: 2, too_basic: 0, off_topic: 1, already_knew: 0 }, myVote: null };

  it("removes the vote on a click on the active reason", () => {
    expect(nextVote("useful", "useful")).toBeNull();
    expect(nextVote("useful", "off_topic")).toBe("off_topic");
    expect(nextVote(null, "too_basic")).toBe("too_basic");
  });

  it("adds, changes, and removes a vote in the counts", () => {
    const added = applyVote(base, "useful");
    expect(added).toEqual({ votes: { useful: 3, too_basic: 0, off_topic: 1, already_knew: 0 }, myVote: "useful" });
    const changed = applyVote(added, "off_topic");
    expect(changed).toEqual({ votes: { useful: 2, too_basic: 0, off_topic: 2, already_knew: 0 }, myVote: "off_topic" });
    const removed = applyVote(changed, null);
    expect(removed).toEqual(base);
    expect(sameVoteState(removed, base)).toBe(true);
  });

  it("never counts below zero", () => {
    expect(applyVote({ ...base, myVote: "already_knew" }, null).votes.already_knew).toBe(0);
  });

  it("knows the votes that hide a story for this browser", () => {
    expect(hidesForMe("off_topic")).toBe(true);
    expect(hidesForMe("too_basic")).toBe(true);
    expect(hidesForMe("useful")).toBe(false);
    expect(hidesForMe(null)).toBe(false);
  });
});
