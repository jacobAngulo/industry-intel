import { describe, expect, it } from "vitest";

import { parseInput } from "@/app/_lib/action-helpers";

import {
  defaultsInput,
  digestInput,
  feedDeliveryInput,
  feedInterestsInput,
  feedProfileInput,
  feedSourceInput,
  phraseListSchema,
  quietHoursInput,
  rejudgeInput,
  teamProfileInput,
  topicInput,
  topicUpdateInput,
} from "./schemas";

const digest = { frequency: "weekdays", weekday: 1, time: "08:30", timeZone: "Europe/Berlin", maxStories: 10 };
const quietHours = { enabled: false, start: "18:00", end: "08:00" };
const alerts = { enabled: true, rule: "A breaking change in a tool that this feed follows.", minRelevance: 85 };
const relevancePriorities = { practical: "strong", experiment: "off", other: "" };

describe("phraseListSchema (exclusions)", () => {
  it("trims, drops duplicates with another case, and keeps the order", () => {
    expect(phraseListSchema.parse([" Politics ", "politics", "Beginner tutorials"])).toEqual([
      "Politics",
      "Beginner tutorials",
    ]);
  });
  it("refuses an empty phrase, a long phrase, and more than 50 phrases", () => {
    expect(phraseListSchema.safeParse(["  "]).success).toBe(false);
    expect(phraseListSchema.safeParse(["x".repeat(301)]).success).toBe(false);
    expect(phraseListSchema.safeParse(Array.from({ length: 51 }, (_, i) => `p${i}`)).success).toBe(false);
  });
  it("gives the field error at the index of the bad phrase", () => {
    const result = parseInput(feedInterestsInput, {
      feedId: 1,
      topicPriorities: {},
      exclusions: ["ok", ""],
      relevancePriorities,
      minRelevance: 60,
      halfLifeHours: 48,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.["exclusions.1"]).toBe("A phrase cannot be empty.");
  });
});

describe("time and time zone validation", () => {
  it("accepts HH:MM in 24 hours and an IANA zone", () => {
    expect(digestInput.safeParse(digest).success).toBe(true);
    expect(quietHoursInput.safeParse({ enabled: true, start: "23:59", end: "00:00" }).success).toBe(true);
  });
  it("refuses a bad time", () => {
    for (const time of ["8:30", "24:00", "12:60", "noon", ""]) {
      const result = parseInput(digestInput, { ...digest, time });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors?.time).toBe("Use the form HH:MM (24 hours).");
    }
  });
  it("refuses an unknown time zone", () => {
    const result = parseInput(digestInput, { ...digest, timeZone: "Mars/Olympus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.timeZone).toContain("IANA time zone");
  });
  it("refuses a weekday or a maximum out of range with a plain message", () => {
    const result = parseInput(digestInput, { ...digest, weekday: 7, maxStories: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.weekday).toBe("Enter a whole number from 0 to 6.");
      expect(result.fieldErrors?.maxStories).toBe("Enter a whole number from 1 to 50.");
    }
  });
});

describe("feed settings inputs", () => {
  it("accepts a full delivery input with shared-default (null) brief fields", () => {
    const input = {
      feedId: 3,
      briefFormat: { summaryLength: null, technicalDepth: "overview", suggestedActions: null },
      digest,
      quietHours,
      alerts,
    };
    expect(feedDeliveryInput.parse(input)).toEqual(input);
  });
  it("refuses an unknown brief value and gives nested keys", () => {
    const result = parseInput(feedDeliveryInput, {
      feedId: 3,
      briefFormat: { summaryLength: "huge", technicalDepth: null, suggestedActions: null },
      digest,
      quietHours,
      alerts: { ...alerts, minRelevance: 101 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.["briefFormat.summaryLength"]).toBeDefined();
      expect(result.fieldErrors?.["alerts.minRelevance"]).toBe("Enter a whole number from 0 to 100.");
    }
  });
  it("accepts topic priorities keyed by topic id and refuses other keys", () => {
    const base = { feedId: 1, exclusions: [], relevancePriorities, minRelevance: 60, halfLifeHours: 48 };
    expect(feedInterestsInput.safeParse({ ...base, topicPriorities: { "1": "high", "4": "muted" } }).success).toBe(true);
    expect(feedInterestsInput.safeParse({ ...base, topicPriorities: { abc: "high" } }).success).toBe(false);
    expect(feedInterestsInput.safeParse({ ...base, topicPriorities: { "1": "urgent" } }).success).toBe(false);
  });
  it("refuses a half-life out of 1..720 and a decimal minimum relevance", () => {
    const base = { feedId: 1, topicPriorities: {}, exclusions: [], relevancePriorities };
    expect(feedInterestsInput.safeParse({ ...base, minRelevance: 60, halfLifeHours: 0 }).success).toBe(false);
    expect(feedInterestsInput.safeParse({ ...base, minRelevance: 60.5, halfLifeHours: 48 }).success).toBe(false);
  });
  it("takes a partial interests patch: only the keys of one section", () => {
    expect(feedInterestsInput.parse({ feedId: 1, minRelevance: 70 })).toEqual({ feedId: 1, minRelevance: 70 });
    expect(feedInterestsInput.parse({ feedId: 1, topicPriorities: { "2": "muted" } })).toEqual({
      feedId: 1,
      topicPriorities: { "2": "muted" },
    });
    expect(feedInterestsInput.parse({ feedId: 1, exclusions: ["Crypto"] })).toEqual({ feedId: 1, exclusions: ["Crypto"] });
    expect(feedInterestsInput.safeParse({ feedId: 1 }).success).toBe(false);
    expect(feedInterestsInput.safeParse({ feedId: 1, minRelevance: 101 }).success).toBe(false);
  });
  it("takes a partial delivery patch: only the keys of one section", () => {
    expect(feedDeliveryInput.parse({ feedId: 3, quietHours })).toEqual({ feedId: 3, quietHours });
    expect(feedDeliveryInput.parse({ feedId: 3, alerts })).toEqual({ feedId: 3, alerts });
    expect(feedDeliveryInput.safeParse({ feedId: 3 }).success).toBe(false);
  });
  it("needs a feed name and caps the profile fields", () => {
    const result = parseInput(feedProfileInput, { feedId: 1, name: "  ", purpose: "x".repeat(301), projectContext: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.name).toBe("Enter a name.");
      expect(result.fieldErrors?.purpose).toBe("Use at most 300 characters.");
    }
  });
  it("validates a feed source change", () => {
    expect(feedSourceInput.safeParse({ feedId: 1, sourceId: 2, included: false }).success).toBe(true);
    expect(
      feedSourceInput.safeParse({ feedId: 1, sourceId: 2, included: true, priority: "high", follow: "agents", ignore: "" })
        .success,
    ).toBe(true);
    expect(feedSourceInput.safeParse({ feedId: 1, sourceId: 2, included: true, priority: "urgent" }).success).toBe(false);
    expect(feedSourceInput.safeParse({ feedId: 0, sourceId: 2, included: true }).success).toBe(false);
  });
  it("needs at least one feed for a re-judge", () => {
    expect(rejudgeInput.safeParse({ feedIds: [] }).success).toBe(false);
    expect(rejudgeInput.safeParse({ feedIds: [1, 2], sourceId: 4 }).success).toBe(true);
  });
});

describe("shared settings inputs", () => {
  it("caps the shared feed profile fields at 4000 characters", () => {
    const profile = { whatWeDo: "a", constraints: "" };
    expect(teamProfileInput.safeParse(profile).success).toBe(true);
    expect(teamProfileInput.safeParse({ ...profile, constraints: "x".repeat(4001) }).success).toBe(false);
  });
  it("validates topics", () => {
    expect(topicInput.safeParse({ name: "Evaluations", description: "" }).success).toBe(true);
    expect(topicInput.safeParse({ name: "", description: "" }).success).toBe(false);
    expect(topicUpdateInput.safeParse({ id: 2, name: "x".repeat(121), description: "" }).success).toBe(false);
  });
  it("accepts the full defaults input", () => {
    const input = {
      briefDefaults: { summaryLength: "standard", technicalDepth: "practitioner", suggestedActions: true },
      defaultExclusions: ["Politics"],
      feedDefaults: { minRelevance: 60, halfLifeHours: 48, digest, quietHours, alerts: { ...alerts, enabled: false } },
    };
    expect(defaultsInput.parse(input)).toEqual(input);
    expect(
      defaultsInput.safeParse({ ...input, briefDefaults: { ...input.briefDefaults, suggestedActions: null } }).success,
    ).toBe(false);
  });
});
