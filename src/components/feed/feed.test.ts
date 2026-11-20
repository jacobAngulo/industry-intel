import { describe, expect, it } from "vitest";

import type { SourceRow } from "@/lib/services/types";

import { digestsSeenKey, formatPeriod, isDigestNew, parseDigestsSeen } from "./digest-format";
import { DEFAULT_FEED_QUERY, feedHref, parseFeedQuery, widerWindow } from "./feed-query";
import { alertsHiddenForMe, backfillText, feedSourceProblems } from "./feed-view";
import {
  addSuggestionInputSchema,
  analysisInputSchema,
  createFeedInputSchema,
  flagSourceInputSchema,
  voteInputSchema,
} from "./schemas";

describe("parseFeedQuery", () => {
  it("gives the defaults for an empty query", () => {
    expect(parseFeedQuery({})).toEqual({ window: "week", sort: "top", topic: null, filtered: false, limit: 50 });
  });

  it("reads every parameter", () => {
    expect(
      parseFeedQuery({ window: "today", sort: "new", topic: "coding-agents", show: "filtered", limit: "100" }),
    ).toEqual({ window: "today", sort: "new", topic: "coding-agents", filtered: true, limit: 100 });
  });

  it("falls back to the defaults for bad values", () => {
    expect(
      parseFeedQuery({ window: "year", sort: "random", topic: "<script>", show: "all", limit: "-5" }),
    ).toEqual(DEFAULT_FEED_QUERY);
    expect(parseFeedQuery({ limit: "abc" }).limit).toBe(50);
    expect(parseFeedQuery({ limit: "0" }).limit).toBe(50);
    expect(parseFeedQuery({ limit: "1.5" }).limit).toBe(50);
    expect(parseFeedQuery({ topic: "a b" }).topic).toBeNull();
    expect(parseFeedQuery({ topic: "x".repeat(200) }).topic).toBeNull();
  });

  it("caps the limit and takes the first of repeated values", () => {
    expect(parseFeedQuery({ limit: "999999" }).limit).toBe(1000);
    expect(parseFeedQuery({ window: ["month", "today"] }).window).toBe("month");
  });

  it("accepts a topic slug of another script and lower-cases it", () => {
    expect(parseFeedQuery({ topic: "Café-Ops" }).topic).toBe("café-ops");
    expect(parseFeedQuery({ topic: "データ" }).topic).toBe("データ");
  });
});

describe("feedHref", () => {
  it("leaves the defaults out of the address", () => {
    expect(feedHref("agentic-development", DEFAULT_FEED_QUERY)).toBe("/f/agentic-development");
  });

  it("sets the changed values", () => {
    expect(feedHref("a", DEFAULT_FEED_QUERY, { window: "today", sort: "new" })).toBe("/f/a?window=today&sort=new");
    expect(feedHref("a", DEFAULT_FEED_QUERY, { filtered: true })).toBe("/f/a?show=filtered");
    expect(feedHref("a", DEFAULT_FEED_QUERY, { topic: "coding-agents" })).toBe("/f/a?topic=coding-agents");
  });

  it("starts again at the default limit when a filter changes", () => {
    const current = { ...DEFAULT_FEED_QUERY, limit: 150 };
    expect(feedHref("a", current, { window: "month" })).toBe("/f/a?window=month");
    expect(feedHref("a", current, { limit: 200 })).toBe("/f/a?limit=200");
    expect(feedHref("a", current)).toBe("/f/a?limit=150");
  });

  it("encodes the slug and the topic", () => {
    expect(feedHref("café", DEFAULT_FEED_QUERY, { topic: "données" })).toBe("/f/caf%C3%A9?topic=donn%C3%A9es");
  });

  it("offers a wider window", () => {
    expect(widerWindow("today")).toBe("week");
    expect(widerWindow("week")).toBe("month");
    expect(widerWindow("month")).toBeNull();
  });
});

describe("digest helpers", () => {
  it("names the localStorage key per feed", () => {
    expect(digestsSeenKey(3)).toBe("ii.digestsSeen.3");
  });

  it("parses the stored visit time", () => {
    expect(parseDigestsSeen("1795169379090")).toBe(1795169379090);
    expect(parseDigestsSeen("x")).toBeNull();
    expect(parseDigestsSeen(null)).toBeNull();
    expect(parseDigestsSeen("-4")).toBeNull();
  });

  it("marks a digest as new when it is newer than the last visit", () => {
    expect(isDigestNew(200, 100)).toBe(true);
    expect(isDigestNew(100, 200)).toBe(false);
    expect(isDigestNew(100, null)).toBe(true);
  });

  it("formats the period in the time zone of the feed", () => {
    const start = Date.UTC(2026, 10, 19, 7, 30);
    const end = Date.UTC(2026, 10, 20, 7, 30);
    expect(formatPeriod(start, end, "Europe/Berlin")).toBe(
      "19 Nov 2026, 08:30 – 20 Nov 2026, 08:30 (Europe/Berlin)",
    );
    expect(formatPeriod(start, end, "Not/AZone")).toBe("19 Nov 2026, 07:30 – 20 Nov 2026, 07:30 (UTC)");
  });
});

describe("action schemas", () => {
  it("accepts a vote and a vote removal", () => {
    expect(voteInputSchema.parse({ feedSlug: "agentic-development", storyId: 3, reason: "useful", from: "list" })).toEqual({
      feedSlug: "agentic-development",
      storyId: 3,
      reason: "useful",
      from: "list",
    });
    expect(voteInputSchema.safeParse({ feedSlug: "a", storyId: 3, reason: null, from: "story" }).success).toBe(true);
  });

  it("refuses a bad vote", () => {
    for (const input of [
      { feedSlug: "a", storyId: 3, reason: "great", from: "list" },
      { feedSlug: "a", storyId: 0, reason: "useful", from: "list" },
      { feedSlug: "a", storyId: 1.5, reason: "useful", from: "list" },
      { feedSlug: "../x", storyId: 1, reason: "useful", from: "list" },
      { feedSlug: "a", storyId: 1, reason: "useful", from: "elsewhere" },
      { feedSlug: "", storyId: 1, reason: "useful", from: "list" },
    ]) {
      expect(voteInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("validates the analysis request", () => {
    expect(analysisInputSchema.safeParse({ feedSlug: "a", storyId: 2 }).success).toBe(true);
    expect(analysisInputSchema.safeParse({ feedSlug: "a", storyId: "2" }).success).toBe(false);
  });

  it("caps the note of a noisy flag and makes it optional", () => {
    expect(flagSourceInputSchema.parse({ feedSlug: "a", storyId: 1, sourceId: 2 }).note).toBe("");
    expect(flagSourceInputSchema.parse({ feedSlug: "a", storyId: 1, sourceId: 2, note: "  loud  " }).note).toBe("loud");
    expect(flagSourceInputSchema.safeParse({ feedSlug: "a", storyId: 1, sourceId: 2, note: "x".repeat(301) }).success).toBe(
      false,
    );
  });

  it("needs the name of a suggestion", () => {
    expect(addSuggestionInputSchema.safeParse({ feedSlug: "a", name: "Claude Code releases" }).success).toBe(true);
    expect(addSuggestionInputSchema.safeParse({ feedSlug: "a", name: " " }).success).toBe(false);
    expect(addSuggestionInputSchema.safeParse({ feedSlug: "a", name: "x".repeat(121) }).success).toBe(false);
  });

  it("validates a new feed with messages at the fields", () => {
    expect(createFeedInputSchema.parse({ name: "  Security  " })).toEqual({ name: "Security", purpose: "" });
    const empty = createFeedInputSchema.safeParse({ name: " ", purpose: "x".repeat(301) });
    expect(empty.success).toBe(false);
    const paths = empty.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    expect(paths).toEqual(["name: Enter a name for the feed.", "purpose: Use at most 300 characters."]);
  });
});

describe("alertsHiddenForMe", () => {
  const rows = [{ alertId: 7, storyId: 1, headline: "A" }];
  it("gives the alerts with no visible story when the search covered every visible story", () => {
    expect(alertsHiddenForMe(rows, [7, 9], true)).toEqual([9]);
    expect(alertsHiddenForMe(rows, [7], true)).toEqual([]);
  });
  it("gives nothing when the search was cut by its limit", () => {
    expect(alertsHiddenForMe(rows, [7, 9], false)).toEqual([]);
  });
});

describe("feedSourceProblems", () => {
  const row = (id: number, patch: Partial<SourceRow>): SourceRow => ({
    id,
    type: "x_user",
    name: `@s${id}`,
    url: null,
    status: "active",
    statusDetail: null,
    feeds: [],
    lastSuccessAt: null,
    usefulStories: 0,
    signalRate: null,
    openFlags: 0,
    addedBy: "Ana",
    owner: null,
    hints: [],
    ...patch,
  });
  const token = "Needs an X API token. Add X_BEARER_TOKEN to the .env file.";

  it("lists the included sources with a problem and their reason", () => {
    const result = feedSourceProblems([
      { source: row(1, { status: "needs_token", statusDetail: token }), included: true },
      { source: row(2, {}), included: true },
      { source: row(3, { status: "needs_setup", statusDetail: "Set IMAP_HOST." }), included: false },
    ]);
    expect(result).toEqual({ problems: [{ id: 1, name: "@s1", reason: token }], all: false });
  });

  it("says when every source of the feed has a problem", () => {
    const result = feedSourceProblems([
      { source: row(1, { status: "needs_token", statusDetail: token }), included: true },
      { source: row(2, { status: "paused" }), included: true },
      { source: row(3, {}), included: false },
    ]);
    expect(result.all).toBe(true);
    expect(result.problems.map((p) => p.id)).toEqual([1, 2]);
    expect(feedSourceProblems([]).all).toBe(false);
  });
});

describe("backfillText", () => {
  it("names a backfill of new sources and a re-judge of the feed differently", () => {
    expect(backfillText({ kind: "backfill", done: 2, total: 8 })).toBe(
      "Recent stories of the new sources are in the queue: 2 of 8 done",
    );
    expect(backfillText({ kind: "rejudge", done: 0, total: 40 })).toBe("Re-judging recent stories: 0 of 40 done");
  });
});
