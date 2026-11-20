import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHOICE,
  addPhrase,
  alertsFromDraft,
  changedTopicPriorities,
  defaultOptionLabel,
  digestFromDraft,
  digestToDraft,
  errorFor,
  failedChecksText,
  filterFeedSources,
  fromChoice,
  fromOnOffChoice,
  groupByType,
  modelCalls,
  parseWholeNumber,
  queuedStoriesText,
  rejudgeProgressText,
  removePhrase,
  samePhrases,
  sourceStatusBadge,
  supportedTimeZones,
  textChanged,
  timeZoneOptions,
  toChoice,
} from "./helpers";

describe("addPhrase / removePhrase", () => {
  it("adds a trimmed phrase with single spaces", () => {
    expect(addPhrase(["Politics"], "  Funding   announcements ")).toEqual({ list: ["Politics", "Funding announcements"] });
  });
  it("refuses an empty phrase, a duplicate with another case, a long phrase, and a full list", () => {
    expect(addPhrase([], "   ")).toEqual({ error: "Enter a phrase." });
    expect(addPhrase(["Politics"], "politics")).toEqual({ error: '"politics" is in the list already.' });
    expect(addPhrase([], "x".repeat(301))).toEqual({ error: "Use at most 300 characters." });
    const full = Array.from({ length: 50 }, (_, i) => `p${i}`);
    expect(addPhrase(full, "new")).toEqual({ error: "The list has 50 phrases, the maximum." });
  });
  it("removes by index", () => {
    expect(removePhrase(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
  it("compares lists with no case difference", () => {
    expect(samePhrases(["A", "b"], ["a", "B"])).toBe(true);
    expect(samePhrases(["a"], ["a", "b"])).toBe(false);
    expect(samePhrases(["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("textChanged", () => {
  it("ignores spaces at the ends", () => {
    expect(textChanged("agents ", " agents")).toBe(false);
    expect(textChanged("agents", "agents, MCP")).toBe(true);
  });
});

describe("parseWholeNumber", () => {
  it("accepts whole numbers in range", () => {
    expect(parseWholeNumber(" 60 ", 0, 100)).toEqual({ value: 60 });
    expect(parseWholeNumber("0", 0, 100)).toEqual({ value: 0 });
  });
  it("refuses text, decimals, empty text, and numbers out of range", () => {
    for (const raw of ["", "abc", "6.5", "101", "-1", "1e3"]) {
      expect(parseWholeNumber(raw, 0, 100)).toEqual({ error: "Enter a whole number from 0 to 100." });
    }
  });
});

describe("brief format choices (shared default)", () => {
  it("maps null to the default choice and back", () => {
    expect(toChoice(null)).toBe(DEFAULT_CHOICE);
    expect(fromChoice(DEFAULT_CHOICE, ["short", "standard", "detailed"] as const)).toBeNull();
  });
  it("keeps a feed value", () => {
    expect(toChoice("detailed")).toBe("detailed");
    expect(fromChoice("detailed", ["short", "standard", "detailed"] as const)).toBe("detailed");
  });
  it("maps an unknown choice to the default", () => {
    expect(fromChoice("huge", ["short", "standard", "detailed"] as const)).toBeNull();
  });
  it("maps suggested actions on / off / default", () => {
    expect(toChoice(true)).toBe("on");
    expect(toChoice(false)).toBe("off");
    expect(fromOnOffChoice("on")).toBe(true);
    expect(fromOnOffChoice("off")).toBe(false);
    expect(fromOnOffChoice(DEFAULT_CHOICE)).toBeNull();
  });
  it("names the default value in the option label", () => {
    expect(defaultOptionLabel("Standard")).toBe("Use the shared default (Standard)");
  });
});

describe("time zones", () => {
  it("puts the current zone first, once", () => {
    expect(timeZoneOptions("Europe/Berlin", ["America/New_York", "Europe/Berlin", "UTC"])).toEqual([
      "Europe/Berlin",
      "America/New_York",
      "UTC",
    ]);
  });
  it("keeps a current zone that the list does not have", () => {
    expect(timeZoneOptions("Etc/GMT+5", ["UTC"])).toEqual(["Etc/GMT+5", "UTC"]);
  });
  it("lists the zones of the runtime with UTC", () => {
    const zones = supportedTimeZones();
    expect(zones).toContain("UTC");
    expect(zones.length).toBeGreaterThan(1);
  });
});

describe("delivery drafts", () => {
  const digest = { frequency: "weekly" as const, weekday: 2, time: "08:30", timeZone: "UTC", maxStories: 10 };
  it("round-trips a digest", () => {
    expect(digestFromDraft(digestToDraft(digest))).toEqual({ value: digest });
  });
  it("reports a bad maximum at the prefixed key", () => {
    expect(digestFromDraft({ ...digestToDraft(digest), maxStories: "0" }, "feedDefaults.digest")).toEqual({
      errors: { "feedDefaults.digest.maxStories": "Enter a whole number from 1 to 50." },
    });
  });
  it("parses the alert draft and trims the rule", () => {
    expect(alertsFromDraft({ enabled: true, rule: " Security notices ", minRelevance: "85" })).toEqual({
      value: { enabled: true, rule: "Security notices", minRelevance: 85 },
    });
    expect(alertsFromDraft({ enabled: true, rule: "", minRelevance: "x" })).toEqual({
      errors: { "alerts.minRelevance": "Enter a whole number from 0 to 100." },
    });
  });
});

describe("feed sources", () => {
  const row = (id: number, type: "github" | "blog" | "x_user", name: string, included: boolean) => ({
    id,
    included,
    source: { id, type, name, status: "active" as const, statusDetail: null },
  });
  const rows = [row(1, "github", "Claude Code releases", true), row(2, "blog", "OpenAI news", false), row(3, "x_user", "@chamath", true)];

  it("filters by name and by inclusion", () => {
    expect(filterFeedSources(rows, "CLAUDE", false).map((r) => r.id)).toEqual([1]);
    expect(filterFeedSources(rows, "", true).map((r) => r.id)).toEqual([1, 3]);
    expect(filterFeedSources(rows, "news", true)).toEqual([]);
  });
  it("groups in the type order and leaves out empty groups", () => {
    expect(groupByType(rows).map((g) => g.type)).toEqual(["x_user", "blog", "github"]);
  });
  it("labels each status", () => {
    expect(sourceStatusBadge("needs_token")).toEqual({ label: "Needs token", tone: "warning" });
    expect(sourceStatusBadge("failing").label).toBe("Failing");
    expect(sourceStatusBadge("waiting").label).toBe("Waiting for first check");
    expect(sourceStatusBadge("active").label).toBe("Active");
  });
});

describe("texts", () => {
  it("counts model calls", () => {
    expect(modelCalls(1)).toBe("1 model call");
    expect(modelCalls(12)).toBe("12 model calls");
  });
  it("says how many stories an include queued", () => {
    expect(queuedStoriesText(3)).toBe("3 recent stories are queued for this feed.");
    expect(queuedStoriesText(1)).toBe("1 recent story is queued for this feed.");
    expect(queuedStoriesText(0)).toBe("No recent story of this source waits for this feed.");
  });
  it("writes the re-judge progress line", () => {
    expect(rejudgeProgressText({ status: "running", total: 12, done: 5, failed: 0 })).toBe("Re-judging: 5 of 12 done.");
    expect(rejudgeProgressText({ status: "running", total: 12, done: 5, failed: 2 })).toBe(
      "Re-judging: 5 of 12 done, 2 failed.",
    );
    expect(rejudgeProgressText({ status: "queued", total: 0, done: 0, failed: 0 })).toBe(
      "Re-judge queued. It starts when the worker is free.",
    );
    expect(rejudgeProgressText({ status: "done", total: 4, done: 4, failed: 0 })).toBe(
      "The last re-judge is done: 4 of 4 stories.",
    );
  });
});

describe("errorFor", () => {
  it("finds the exact key, else the first key below it", () => {
    const errors = { "exclusions.2": "Too long.", minRelevance: "Bad." };
    expect(errorFor(errors, "minRelevance")).toBe("Bad.");
    expect(errorFor(errors, "exclusions")).toBe("Too long.");
    expect(errorFor(errors, "halfLifeHours")).toBeNull();
    expect(errorFor(undefined, "x")).toBeNull();
  });
});

describe("changedTopicPriorities", () => {
  it("keeps only the listed topics whose priority changed (missing = normal)", () => {
    const saved = { "1": "high", "2": "muted" } as const;
    const draft = { "1": "high", "2": "normal", "3": "low", "9": "high" } as const;
    expect(changedTopicPriorities<string>(saved, draft, [1, 2, 3, 4], "normal")).toEqual({ "2": "normal", "3": "low" });
    expect(changedTopicPriorities<string>(saved, saved, [1, 2], "normal")).toEqual({});
  });
});

describe("failedChecksText", () => {
  it("says how many checks failed in a row", () => {
    expect(failedChecksText(1)).toBe("1 failed check");
    expect(failedChecksText(3)).toBe("3 failed checks in a row");
  });
});
