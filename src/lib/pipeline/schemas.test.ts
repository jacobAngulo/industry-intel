import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  JUDGE_LIMITS,
  analysisSchema,
  clampInt,
  cleanFeedResult,
  cleanItemFacts,
  cleanJudgeOutput,
  cutText,
  judgeNormalSchema,
  judgeNormalSchemaFor,
  judgeSingleStorySchema,
  judgeSingleStorySchemaFor,
  toAnalysisContent,
  type AnalysisRaw,
  type JudgeFeedResultRaw,
  type JudgeItemFactsRaw,
} from "./schemas";

const feedResult = (overrides: Partial<JudgeFeedResultRaw> = {}): JudgeFeedResultRaw => ({
  feed_id: 1,
  relevance: 82,
  reason: "A release of a coding agent that the team uses.",
  why_it_matters: "The new permission mode changes how the team runs agents in CI.",
  suggested_action: "Test the permission mode in one repository.",
  topic_ids: [3],
  exclusion: null,
  novelty: "new",
  depth: "intermediate",
  signals: { practical: 3, experiment: 1 },
  alert: false,
  ...overrides,
});

const itemFacts = (overrides: Partial<JudgeItemFactsRaw> = {}): JudgeItemFactsRaw => ({
  headline: "Claude Code 3.2 adds a permission mode for CI",
  summary: ["The release adds a permission mode for CI.", "It also fixes two bugs."],
  category: "release",
  entities: ["Claude Code", "Anthropic"],
  substance: "news",
  same_story_id: null,
  adds_new_facts: false,
  ...overrides,
});

describe("judge schemas", () => {
  it("accepts a reply in snake_case, in normal mode and in single-story mode", () => {
    const normal = judgeNormalSchema.safeParse({ item: itemFacts(), feeds: [feedResult()] });
    expect(normal.success).toBe(true);
    const single = judgeSingleStorySchema.safeParse({ feeds: [feedResult(), feedResult({ feed_id: 2 })] });
    expect(single.success).toBe(true);
  });

  it("refuses a wrong structure: a bad enum value, a missing field, an empty summary", () => {
    expect(judgeNormalSchema.safeParse({ item: itemFacts({ category: "gossip" as never }), feeds: [] }).success).toBe(false);
    expect(judgeNormalSchema.safeParse({ item: itemFacts({ summary: [] }), feeds: [] }).success).toBe(false);
    const { why_it_matters: _dropped, ...withoutWhy } = feedResult();
    void _dropped;
    expect(judgeSingleStorySchema.safeParse({ feeds: [withoutWhy] }).success).toBe(false);
    expect(judgeSingleStorySchema.safeParse({ feeds: [feedResult({ novelty: "old" as never })] }).success).toBe(false);
    expect(judgeNormalSchema.safeParse({ feeds: [feedResult()] }).success).toBe(false);
  });

  it("does not refuse a value that is only over a limit (the clean step fixes it)", () => {
    const reply = {
      item: itemFacts({ headline: "x".repeat(200), summary: Array.from({ length: 8 }, (_, i) => `Sentence ${i}.`) }),
      feeds: [feedResult({ relevance: 140, reason: "r".repeat(500) })],
    };
    expect(judgeNormalSchema.safeParse(reply).success).toBe(true);
  });

  it("shows the limits to the model in the JSON schema", () => {
    const json = z.toJSONSchema(judgeNormalSchema) as unknown as {
      properties: {
        item: { properties: Record<string, Record<string, unknown>> };
        feeds: { items: { properties: Record<string, Record<string, unknown>> } };
      };
    };
    const item = json.properties.item.properties;
    const feed = json.properties.feeds.items.properties;
    expect(item.headline?.maxLength).toBe(110);
    expect(item.summary).toMatchObject({ minItems: 1, maxItems: 5 });
    expect(item.entities?.maxItems).toBe(8);
    expect(feed.relevance).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    expect(feed.reason?.maxLength).toBe(200);
    expect(feed.why_it_matters?.maxLength).toBe(240);
    expect(feed.suggested_action?.maxLength).toBe(200);
    expect((feed.signals as { properties: Record<string, unknown> }).properties.practical).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 3,
    });
    // Single-story mode has no `item`.
    const single = z.toJSONSchema(judgeSingleStorySchema) as unknown as { properties: Record<string, unknown> };
    expect(Object.keys(single.properties)).toEqual(["feeds"]);
    // The analysis schema also converts.
    expect(() => z.toJSONSchema(analysisSchema)).not.toThrow();
    expect(() => z.toJSONSchema(judgeNormalSchemaFor([1, 2]))).not.toThrow();
  });

  it("the schema for a call fails when a requested feed has no result", () => {
    const schema = judgeNormalSchemaFor([1, 2]);
    expect(schema.safeParse({ item: itemFacts(), feeds: [feedResult(), feedResult({ feed_id: 2 })] }).success).toBe(true);
    const missing = schema.safeParse({ item: itemFacts(), feeds: [feedResult()] });
    expect(missing.success).toBe(false);
    expect(missing.success ? "" : z.prettifyError(missing.error)).toContain("Missing feed_id: 2");

    const single = judgeSingleStorySchemaFor([5]);
    expect(single.safeParse({ feeds: [feedResult({ feed_id: 5 })] }).success).toBe(true);
    expect(single.safeParse({ feeds: [] }).success).toBe(false);
  });
});

describe("cutText and clampInt", () => {
  it("cuts with an ellipsis inside the limit", () => {
    expect(cutText("short", 10)).toBe("short");
    const cut = cutText("abcdefghij klmnop", 11);
    expect(cut).toBe("abcdefghij…");
    expect(cut.length).toBeLessThanOrEqual(11);
  });

  it("rounds and clamps", () => {
    expect(clampInt(82.6, 0, 100)).toBe(83);
    expect(clampInt(-5, 0, 100)).toBe(0);
    expect(clampInt(140, 0, 100)).toBe(100);
    expect(clampInt(Number.NaN, 0, 3)).toBe(0);
  });
});

describe("cleanItemFacts", () => {
  it("truncates the headline, cuts the lists, and removes duplicates", () => {
    const clean = cleanItemFacts(
      itemFacts({
        headline: `  A   headline\nwith breaks ${"x".repeat(200)}`,
        summary: [" One. ", "", "Two.", "Three.", "Four.", "Five.", "Six."],
        entities: ["Claude Code", "claude code", " ", ...Array.from({ length: 12 }, (_, i) => `Entity ${i}`)],
      }),
    );
    expect(clean.headline.length).toBe(JUDGE_LIMITS.headline);
    expect(clean.headline.startsWith("A headline with breaks")).toBe(true);
    expect(clean.headline.endsWith("…")).toBe(true);
    expect(clean.summary).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
    expect(clean.entities).toHaveLength(8);
    expect(clean.entities[0]).toBe("Claude Code");
    expect(clean.entities).not.toContain("claude code");
  });

  it("keeps same_story_id only when it is one of the candidates", () => {
    expect(cleanItemFacts(itemFacts({ same_story_id: 12, adds_new_facts: true }), [10, 12])).toMatchObject({
      sameStoryId: 12,
      addsNewFacts: true,
    });
    expect(cleanItemFacts(itemFacts({ same_story_id: 99, adds_new_facts: true }), [10, 12])).toMatchObject({
      sameStoryId: null,
      addsNewFacts: false,
    });
    expect(cleanItemFacts(itemFacts({ same_story_id: 12, adds_new_facts: true }))).toMatchObject({ sameStoryId: null });
    expect(cleanItemFacts(itemFacts({ same_story_id: null, adds_new_facts: true })).addsNewFacts).toBe(false);
  });

  it("uses the headline when all summary sentences are empty", () => {
    expect(cleanItemFacts(itemFacts({ summary: ["  ", ""] })).summary).toEqual(["Claude Code 3.2 adds a permission mode for CI"]);
  });
});

describe("cleanFeedResult", () => {
  it("clamps the integers and truncates the strings", () => {
    const clean = cleanFeedResult(
      feedResult({
        relevance: 104.4,
        reason: "r".repeat(400),
        why_it_matters: "w".repeat(400),
        suggested_action: "a".repeat(400),
        signals: { practical: 7, experiment: 1.6 },
      }),
      [3],
    );
    expect(clean.relevance).toBe(100);
    expect(clean.reason.length).toBe(200);
    expect(clean.whyItMatters.length).toBe(240);
    expect(clean.suggestedAction?.length).toBe(200);
    expect(clean.signals).toEqual({ practical: 3, experiment: 2 });
    expect(cleanFeedResult(feedResult({ relevance: -3 }), []).relevance).toBe(0);
  });

  it("drops topic ids that do not exist, and duplicates", () => {
    expect(cleanFeedResult(feedResult({ topic_ids: [3, 3, 99, 4.0, 2.5] }), [3, 4]).topicIds).toEqual([3, 4]);
    expect(cleanFeedResult(feedResult({ topic_ids: [3] }), []).topicIds).toEqual([]);
  });

  it("makes an empty action and an empty exclusion null, and keeps the source filter value", () => {
    expect(cleanFeedResult(feedResult({ suggested_action: "  " }), []).suggestedAction).toBeNull();
    expect(cleanFeedResult(feedResult({ suggested_action: "null" }), []).suggestedAction).toBeNull();
    expect(cleanFeedResult(feedResult({ exclusion: "" }), []).exclusion).toBeNull();
    expect(cleanFeedResult(feedResult({ exclusion: " Source Filter " }), []).exclusion).toBe("source filter");
    expect(cleanFeedResult(feedResult({ exclusion: "Funding announcements" }), []).exclusion).toBe("Funding announcements");
  });
});

describe("cleanJudgeOutput", () => {
  it("drops feed ids that were not asked for, keeps the first result of a feed, and lists the missing feeds", () => {
    const clean = cleanJudgeOutput(
      {
        item: itemFacts({ same_story_id: 7 }),
        feeds: [feedResult({ feed_id: 1, relevance: 80 }), feedResult({ feed_id: 9 }), feedResult({ feed_id: 1, relevance: 10 })],
      },
      { feedIds: [1, 2], topicIds: [3], candidateStoryIds: [7] },
    );
    expect(clean.feeds).toHaveLength(1);
    expect(clean.feeds[0]).toMatchObject({ feedId: 1, relevance: 80, topicIds: [3] });
    expect(clean.missingFeedIds).toEqual([2]);
    expect(clean.item?.sameStoryId).toBe(7);
  });

  it("has no item in single-story mode", () => {
    const clean = cleanJudgeOutput({ feeds: [feedResult({ feed_id: 2 })] }, { feedIds: [2], topicIds: [] });
    expect(clean.item).toBeNull();
    expect(clean.missingFeedIds).toEqual([]);
    expect(clean.feeds[0]?.topicIds).toEqual([]);
  });
});

describe("toAnalysisContent", () => {
  const raw = (overrides: Partial<AnalysisRaw> = {}): AnalysisRaw => ({
    what_changed: ["The release adds a permission mode.", "  "],
    how_it_works: [],
    what_it_means_for_us: ["The team can run agents in CI with fewer prompts."],
    risks_and_limits: ["The sources do not say how the mode handles secrets."],
    suggested_actions: [
      { action: "Test the mode in one repository.", why: "It removes manual approvals.", effort: "quick_check", first_step: "Read the release notes." },
      { action: " ", why: "Empty.", effort: "project", first_step: "None." },
    ],
    open_questions: ["Does it work with self-hosted runners?"],
    confidence: "medium",
    confidence_note: "Only the release notes were available.",
    sources_used: ["https://example.com/release/", "https://evil.example.net/x", "https://example.com/release"],
    ...overrides,
  });

  it("parses the snake_case reply and converts it to the camelCase content", () => {
    expect(analysisSchema.safeParse(raw()).success).toBe(true);
    expect(analysisSchema.safeParse(raw({ confidence: "certain" as never })).success).toBe(false);

    const content = toAnalysisContent(raw(), { allowedUrls: ["https://example.com/release"], suggestedActions: true });
    expect(content).toEqual({
      whatChanged: ["The release adds a permission mode."],
      howItWorks: [],
      whatItMeansForUs: ["The team can run agents in CI with fewer prompts."],
      risksAndLimits: ["The sources do not say how the mode handles secrets."],
      suggestedActions: [
        {
          action: "Test the mode in one repository.",
          why: "It removes manual approvals.",
          effort: "quick_check",
          firstStep: "Read the release notes.",
        },
      ],
      openQuestions: ["Does it work with self-hosted runners?"],
      confidence: "medium",
      confidenceNote: "Only the release notes were available.",
      // Only the allowed URL stays, one time, in the allowed spelling.
      sourcesUsed: ["https://example.com/release"],
    });
  });

  it("empties the action list when the feed has suggested actions off", () => {
    const content = toAnalysisContent(raw(), { allowedUrls: [], suggestedActions: false });
    expect(content.suggestedActions).toEqual([]);
    expect(content.sourcesUsed).toEqual([]);
  });

  it("cuts long lists and long texts", () => {
    const content = toAnalysisContent(
      raw({
        what_changed: Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${"x".repeat(5000)}`),
        open_questions: Array.from({ length: 30 }, (_, i) => `Question ${i}?`),
        confidence_note: "n".repeat(3000),
      }),
      { allowedUrls: [], suggestedActions: true },
    );
    expect(content.whatChanged).toHaveLength(12);
    expect(content.whatChanged[0]?.length).toBe(4000);
    expect(content.openQuestions).toHaveLength(10);
    expect(content.confidenceNote.length).toBe(1000);
  });
});
