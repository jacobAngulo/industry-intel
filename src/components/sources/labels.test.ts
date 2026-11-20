import { describe, expect, it } from "vitest";

import type { ItemOutcome } from "@/lib/services/types";

import {
  formatInterval,
  formatSignalRate,
  intervalOptions,
  isHttpUrl,
  itemOutcomeText,
  joinNames,
  sourceNoteLine,
  sourceProblem,
} from "./labels";

function item(patch: Partial<ItemOutcome>): ItemOutcome {
  return {
    itemId: 1,
    title: "t",
    url: null,
    publishedAt: null,
    fetchedAt: 0,
    judgeStatus: "judged",
    skipReason: null,
    storyId: 1,
    perFeed: [],
    ...patch,
  };
}
const feed = { feedSlug: "a", feedName: "A", relevance: 72, hidden: null };

describe("labels", () => {
  it("formats the signal rate and the interval", () => {
    expect(formatSignalRate(null)).toBe("–");
    expect(formatSignalRate(0.004)).toBe("< 1 %");
    expect(formatSignalRate(0.666)).toBe("67 %");
    expect(formatInterval(60)).toBe("Every hour");
    expect(formatInterval(120)).toBe("Every 2 h");
    expect(formatInterval(45)).toBe("Every 45 min");
    expect(formatInterval(1440)).toBe("Every day");
    expect(formatInterval(10080)).toBe("Every week");
  });

  it("offers the presets, the default of the type, and the current value", () => {
    const options = intervalOptions(45, 720);
    expect(options.map((o) => o.value)).toContain("45");
    expect(options.find((o) => o.value === "720")?.label).toBe("Every 12 h (default for this type)");
    expect(options.map((o) => Number(o.value))).toEqual([...options.map((o) => Number(o.value))].sort((a, b) => a - b));
  });

  it("says the outcome of an item in a feed", () => {
    expect(itemOutcomeText(item({ judgeStatus: "pending" }), feed).text).toBe("Waiting for the model");
    expect(itemOutcomeText(item({ judgeStatus: "skipped", skipReason: "too_old" }), feed).text).toBe("Skipped: too old when it arrived");
    expect(itemOutcomeText(item({}), feed)).toEqual({ text: "Relevance 72 · shown", tone: "shown" });
    expect(itemOutcomeText(item({}), { ...feed, hidden: "muted_topic" }).text).toBe("Relevance 72 · filtered: muted topic");
    expect(itemOutcomeText(item({}), { ...feed, relevance: null }).tone).toBe("none");
  });

  it("links only http and https addresses", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("sourceNoteLine and sourceProblem", () => {
  const failingHint = "Failing since 20 Nov 2026 08:00 UTC: HTTP 500. Next try: 20 Nov 2026 09:00 UTC.";
  it("shows the failing hint before other hints, then the status detail, then the first hint", () => {
    expect(sourceNoteLine({ status: "failing", statusDetail: "HTTP 500", hints: ["Flagged as noisy by 1 person.", failingHint] })).toBe(failingHint);
    expect(sourceNoteLine({ status: "needs_token", statusDetail: "Add X_BEARER_TOKEN to the .env file.", hints: ["Not in any feed."] })).toBe(
      "Add X_BEARER_TOKEN to the .env file.",
    );
    expect(sourceNoteLine({ status: "active", statusDetail: null, hints: ["Not in any feed."] })).toBe("Not in any feed.");
    expect(sourceNoteLine({ status: "active", statusDetail: null, hints: [] })).toBeNull();
  });
  it("gives a reason only for a source that brings no items", () => {
    expect(sourceProblem({ status: "needs_setup", statusDetail: null, hints: [] })).toBe("Needs setup");
    expect(sourceProblem({ status: "needs_token", statusDetail: "Add X_BEARER_TOKEN.", hints: [] })).toBe("Add X_BEARER_TOKEN.");
    expect(sourceProblem({ status: "failing", statusDetail: "HTTP 500", hints: [failingHint] })).toBe(failingHint);
    expect(sourceProblem({ status: "paused", statusDetail: null, hints: [] })).toMatch(/^Paused/);
    expect(sourceProblem({ status: "active", statusDetail: "X credits are used up.", hints: [] })).toBe("X credits are used up.");
    expect(sourceProblem({ status: "active", statusDetail: null, hints: ["Flagged as noisy by 1 person."] })).toBeNull();
    expect(sourceProblem({ status: "waiting", statusDetail: null, hints: [] })).toBeNull();
  });
});
