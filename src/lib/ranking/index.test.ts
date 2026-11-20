import { describe, expect, it } from "vitest";

import { DEFAULT_RELEVANCE_PRIORITIES, emptyVotes, type FeedbackReason, type RankPart } from "@/lib/types";

import {
  baseScore,
  decayedScore,
  effectiveHalfLife,
  hiddenReason,
  sourceQualityScore,
  type RankInput,
} from "./index";

/** A neutral input: relevance 70, visible, every term of §8.2 is zero. */
function input(overrides: Partial<RankInput> = {}): RankInput {
  return {
    relevance: 70,
    exclusion: null,
    substance: "news",
    topicPriorities: [],
    topicNames: [],
    // With all weights "off" the term P is zero.
    signals: { practical: 0, experiment: 0 },
    priorities: { practical: "off", experiment: "off", other: "" },
    sourcePriority: "normal",
    sourceQuality: null,
    sourceCount: 1,
    novelty: "new",
    depth: "intermediate",
    feedDepth: "practitioner",
    votes: emptyVotes(),
    minRelevance: 60,
    ...overrides,
  };
}

function votes(counts: Partial<Record<FeedbackReason, number>>): Record<FeedbackReason, number> {
  return { ...emptyVotes(), ...counts };
}

function part(parts: RankPart[], key: string): RankPart | undefined {
  return parts.find((p) => p.key === key);
}

describe("hiddenReason (§8.1)", () => {
  it("a neutral judgement is visible", () => {
    expect(hiddenReason(input())).toBeNull();
  });

  describe("1. source_removed", () => {
    it("hides when no source of the story is in the feed", () => {
      expect(hiddenReason(input({ sourcePriority: null }))).toBe("source_removed");
    });

    it("has no exception for useful votes", () => {
      expect(hiddenReason(input({ sourcePriority: null, votes: votes({ useful: 5 }) }))).toBe("source_removed");
    });

    it("wins over each later reason", () => {
      expect(
        hiddenReason(
          input({
            sourcePriority: null,
            exclusion: "Politics",
            topicPriorities: ["muted"],
            substance: "promo",
            relevance: 10,
            votes: votes({ off_topic: 3 }),
          }),
        ),
      ).toBe("source_removed");
    });
  });

  describe("2. feedback", () => {
    it("needs 2 votes of one negative reason", () => {
      expect(hiddenReason(input({ votes: votes({ off_topic: 1 }) }))).toBeNull();
      expect(hiddenReason(input({ votes: votes({ off_topic: 2 }) }))).toBe("feedback");
      expect(hiddenReason(input({ votes: votes({ too_basic: 1 }) }))).toBeNull();
      expect(hiddenReason(input({ votes: votes({ too_basic: 2 }) }))).toBe("feedback");
    });

    it("does not add the two negative reasons together", () => {
      expect(hiddenReason(input({ votes: votes({ off_topic: 1, too_basic: 1 }) }))).toBeNull();
    });

    it("needs more negative votes of that reason than useful votes", () => {
      expect(hiddenReason(input({ votes: votes({ off_topic: 2, useful: 2 }) }))).toBeNull();
      expect(hiddenReason(input({ votes: votes({ off_topic: 3, useful: 2 }) }))).toBe("feedback");
      expect(hiddenReason(input({ votes: votes({ too_basic: 2, useful: 2 }) }))).toBeNull();
      expect(hiddenReason(input({ votes: votes({ too_basic: 3, useful: 2 }) }))).toBe("feedback");
    });

    it("ignores the votes 'already knew this'", () => {
      expect(hiddenReason(input({ votes: votes({ already_knew: 9 }) }))).toBeNull();
    });

    it("wins over exclusion", () => {
      expect(hiddenReason(input({ exclusion: "Politics", votes: votes({ off_topic: 2 }) }))).toBe("feedback");
    });
  });

  describe("3. exclusion", () => {
    it("hides a judgement that has an exclusion", () => {
      expect(hiddenReason(input({ exclusion: "Funding announcements" }))).toBe("exclusion");
      expect(hiddenReason(input({ exclusion: "source filter" }))).toBe("exclusion");
    });

    it("unless useful > off_topic + too_basic", () => {
      expect(hiddenReason(input({ exclusion: "Politics", votes: votes({ useful: 1 }) }))).toBeNull();
      expect(hiddenReason(input({ exclusion: "Politics", votes: votes({ useful: 2, off_topic: 1 }) }))).toBeNull();
      // Equal counts are not enough.
      expect(hiddenReason(input({ exclusion: "Politics", votes: votes({ useful: 1, off_topic: 1 }) }))).toBe("exclusion");
      // The two negative reasons count together.
      expect(
        hiddenReason(input({ exclusion: "Politics", votes: votes({ useful: 2, off_topic: 1, too_basic: 1 }) })),
      ).toBe("exclusion");
    });

    it("does not count 'already knew this' as negative", () => {
      expect(hiddenReason(input({ exclusion: "Politics", votes: votes({ useful: 1, already_knew: 4 }) }))).toBeNull();
    });

    it("wins over muted_topic", () => {
      expect(hiddenReason(input({ exclusion: "Politics", topicPriorities: ["muted"] }))).toBe("exclusion");
    });
  });

  describe("4. muted_topic", () => {
    it("hides when one matched topic is muted", () => {
      expect(hiddenReason(input({ topicPriorities: ["high", "muted"], topicNames: ["A", "B"] }))).toBe("muted_topic");
    });

    it("has no exception for useful votes", () => {
      expect(hiddenReason(input({ topicPriorities: ["muted"], votes: votes({ useful: 4 }) }))).toBe("muted_topic");
    });

    it("shows a rescued exclusion that also has a muted topic as muted_topic", () => {
      expect(
        hiddenReason(input({ exclusion: "Politics", topicPriorities: ["muted"], votes: votes({ useful: 1 }) })),
      ).toBe("muted_topic");
    });

    it("wins over low_substance", () => {
      expect(hiddenReason(input({ topicPriorities: ["muted"], substance: "promo" }))).toBe("muted_topic");
    });
  });

  describe("5. low_substance", () => {
    it("hides promo and chatter", () => {
      expect(hiddenReason(input({ substance: "promo" }))).toBe("low_substance");
      expect(hiddenReason(input({ substance: "chatter" }))).toBe("low_substance");
    });

    it("shows news, report, and analysis", () => {
      for (const substance of ["news", "report", "analysis"] as const) {
        expect(hiddenReason(input({ substance }))).toBeNull();
      }
    });

    it("unless useful > off_topic + too_basic", () => {
      expect(hiddenReason(input({ substance: "chatter", votes: votes({ useful: 1 }) }))).toBeNull();
      expect(hiddenReason(input({ substance: "chatter", votes: votes({ useful: 1, too_basic: 1 }) }))).toBe(
        "low_substance",
      );
    });

    it("wins over below_threshold", () => {
      expect(hiddenReason(input({ substance: "promo", relevance: 10 }))).toBe("low_substance");
    });
  });

  describe("6. below_threshold", () => {
    it("hides a relevance below the minimum of the feed", () => {
      expect(hiddenReason(input({ relevance: 59, minRelevance: 60 }))).toBe("below_threshold");
      expect(hiddenReason(input({ relevance: 60, minRelevance: 60 }))).toBeNull();
      expect(hiddenReason(input({ relevance: 0, minRelevance: 0 }))).toBeNull();
    });

    it("unless useful > off_topic + too_basic", () => {
      expect(hiddenReason(input({ relevance: 30, votes: votes({ useful: 1 }) }))).toBeNull();
      expect(hiddenReason(input({ relevance: 30, votes: votes({ useful: 1, off_topic: 1 }) }))).toBe("below_threshold");
    });
  });
});

describe("baseScore (§8.2)", () => {
  it("is the relevance when every term is zero", () => {
    const { base, parts } = baseScore(input());
    expect(base).toBe(70);
    expect(parts).toEqual([{ key: "relevance", label: "Relevance", value: 70 }]);
  });

  describe("T: topic priority", () => {
    it("+8 when a matched topic is high, and the label names the topic", () => {
      const { base, parts } = baseScore(
        input({ topicPriorities: ["normal", "high", "low"], topicNames: ["Orchestration", "Coding agents", "Other"] }),
      );
      expect(base).toBe(78);
      expect(part(parts, "topic")).toEqual({ key: "topic", label: 'Topic "Coding agents" is high priority', value: 8 });
    });

    it("+8 one time when two topics are high", () => {
      expect(baseScore(input({ topicPriorities: ["high", "high"], topicNames: ["A", "B"] })).base).toBe(78);
    });

    it("-8 when all matched topics are low", () => {
      const one = baseScore(input({ topicPriorities: ["low"], topicNames: ["Model releases"] }));
      expect(one.base).toBe(62);
      expect(part(one.parts, "topic")).toEqual({ key: "topic", label: 'Topic "Model releases" is low priority', value: -8 });
      const two = baseScore(input({ topicPriorities: ["low", "low"], topicNames: ["A", "B"] }));
      expect(two.base).toBe(62);
      expect(part(two.parts, "topic")?.label).toBe("All matched topics are low priority");
    });

    it("0 when a low topic is together with a normal topic, and 0 with no topic", () => {
      expect(baseScore(input({ topicPriorities: ["low", "normal"], topicNames: ["A", "B"] })).base).toBe(70);
      expect(baseScore(input({ topicPriorities: ["normal"], topicNames: ["A"] })).base).toBe(70);
      expect(part(baseScore(input()).parts, "topic")).toBeUndefined();
    });

    it("0 when a muted topic is together with low topics (not all are low)", () => {
      expect(baseScore(input({ topicPriorities: ["low", "muted"], topicNames: ["A", "B"] })).base).toBe(70);
    });
  });

  describe("P: relevance priorities", () => {
    it("is the sum of weight × (signal - 1.5) × 4/3", () => {
      // normal weights: (3 - 1.5) × 4/3 = +2 for each signal of 3.
      const all = baseScore(
        input({ priorities: { ...DEFAULT_RELEVANCE_PRIORITIES }, signals: { practical: 3, experiment: 3 } }),
      );
      expect(all.base).toBe(74);
      expect(part(all.parts, "priorities")?.value).toBe(4);
      // (0 - 1.5) × 4/3 = -2 for each signal of 0.
      expect(
        baseScore(
          input({ priorities: { ...DEFAULT_RELEVANCE_PRIORITIES }, signals: { practical: 0, experiment: 0 } }),
        ).base,
      ).toBe(66);
    });

    it("uses weight 0 for off, 1 for normal, 2 for strong", () => {
      const result = baseScore(
        input({
          priorities: { practical: "strong", experiment: "normal", other: "" },
          signals: { practical: 3, experiment: 0 },
        }),
      );
      // 2 × 1.5 × 4/3 + 1 × -1.5 × 4/3 = 4 - 2 = +2
      expect(result.base).toBe(72);
      const detail = part(result.parts, "priorities")?.detail ?? "";
      expect(detail).toContain("Practical implementation (strong): 3 of 3");
      expect(detail).toContain("Promising things to experiment with (normal): 0 of 3");
      const off = baseScore(
        input({
          priorities: { practical: "off", experiment: "normal", other: "" },
          signals: { practical: 3, experiment: 3 },
        }),
      );
      expect(off.base).toBe(72);
      expect(part(off.parts, "priorities")?.detail ?? "").not.toContain("Practical");
    });

    it("has the limits -8 and +8 (all strong)", () => {
      const strong = { practical: "strong", experiment: "strong", other: "" } as const;
      expect(baseScore(input({ priorities: strong, signals: { practical: 3, experiment: 3 } })).base).toBe(78);
      expect(baseScore(input({ priorities: strong, signals: { practical: 0, experiment: 0 } })).base).toBe(62);
    });

    it("clamps a signal that is out of the range 0..3", () => {
      const strong = { practical: "strong", experiment: "off", other: "" } as const;
      expect(baseScore(input({ priorities: strong, signals: { practical: 9, experiment: 0 } })).base).toBe(74);
      expect(baseScore(input({ priorities: strong, signals: { practical: -4, experiment: 0 } })).base).toBe(66);
    });

    it("rounds the part and the base to 1 decimal", () => {
      // 2 × (2 - 1.5) + 1 × (1 - 1.5) = 0.5; × 4/3 = 0.666…
      const result = baseScore(
        input({ priorities: { practical: "strong", experiment: "normal", other: "" }, signals: { practical: 2, experiment: 1 } }),
      );
      expect(result.base).toBe(70.7);
      expect(part(result.parts, "priorities")?.value).toBe(0.7);
    });

    it("has no part when the term is zero", () => {
      const off = baseScore(input({ signals: { practical: 3, experiment: 3 } }));
      expect(part(off.parts, "priorities")).toBeUndefined();
      // +2 and -2 give zero.
      const balanced = baseScore(
        input({
          priorities: { practical: "normal", experiment: "normal", other: "" },
          signals: { practical: 3, experiment: 0 },
        }),
      );
      expect(balanced.base).toBe(70);
      expect(part(balanced.parts, "priorities")).toBeUndefined();
    });
  });

  describe("S: source priority", () => {
    it("high +5, normal 0, low -5", () => {
      const high = baseScore(input({ sourcePriority: "high" }));
      expect(high.base).toBe(75);
      expect(part(high.parts, "source_priority")).toEqual({
        key: "source_priority",
        label: "A source with high priority in this feed",
        value: 5,
      });
      expect(baseScore(input({ sourcePriority: "low" })).base).toBe(65);
      const normal = baseScore(input({ sourcePriority: "normal" }));
      expect(normal.base).toBe(70);
      expect(part(normal.parts, "source_priority")).toBeUndefined();
    });

    it("0 when no source of the story is in the feed", () => {
      expect(baseScore(input({ sourcePriority: null })).base).toBe(70);
    });
  });

  describe("Q: source quality", () => {
    it("is zero with fewer than 3 votes", () => {
      expect(sourceQualityScore(null)).toBe(0);
      expect(sourceQualityScore({ useful: 2, offTopic: 0, tooBasic: 0 })).toBe(0);
      expect(sourceQualityScore({ useful: 1, offTopic: 1, tooBasic: 0 })).toBe(0);
      const result = baseScore(input({ sourceQuality: { useful: 2, offTopic: 0, tooBasic: 0 } }));
      expect(result.base).toBe(70);
      expect(part(result.parts, "source_quality")).toBeUndefined();
    });

    it("is ((useful + 1) / (n + 2) - 0.5) × 10 with 3 votes or more", () => {
      // (4 / 5 - 0.5) × 10 = +3
      expect(sourceQualityScore({ useful: 3, offTopic: 0, tooBasic: 0 })).toBeCloseTo(3, 10);
      // (1 / 5 - 0.5) × 10 = -3
      expect(sourceQualityScore({ useful: 0, offTopic: 2, tooBasic: 1 })).toBeCloseTo(-3, 10);
      // (3 / 6 - 0.5) × 10 = 0
      expect(sourceQualityScore({ useful: 2, offTopic: 1, tooBasic: 1 })).toBeCloseTo(0, 10);

      const good = baseScore(input({ sourceQuality: { useful: 3, offTopic: 0, tooBasic: 0 } }));
      expect(good.base).toBe(73);
      expect(part(good.parts, "source_quality")?.value).toBe(3);
      expect(part(good.parts, "source_quality")?.detail).toContain("3 useful, 0 off topic, 0 too basic");
      expect(baseScore(input({ sourceQuality: { useful: 0, offTopic: 2, tooBasic: 1 } })).base).toBe(67);
    });

    it("stays inside -5 and +5", () => {
      expect(sourceQualityScore({ useful: 1000, offTopic: 0, tooBasic: 0 })).toBeLessThan(5);
      expect(sourceQualityScore({ useful: 1000, offTopic: 0, tooBasic: 0 })).toBeGreaterThan(4.9);
      expect(sourceQualityScore({ useful: 0, offTopic: 500, tooBasic: 500 })).toBeGreaterThan(-5);
      expect(sourceQualityScore({ useful: 0, offTopic: 500, tooBasic: 500 })).toBeLessThan(-4.9);
    });
  });

  describe("C: corroboration", () => {
    it("is min(6, 3 × log2(source_count))", () => {
      expect(baseScore(input({ sourceCount: 1 })).base).toBe(70);
      expect(part(baseScore(input({ sourceCount: 1 })).parts, "corroboration")).toBeUndefined();
      const two = baseScore(input({ sourceCount: 2 }));
      expect(two.base).toBe(73);
      expect(part(two.parts, "corroboration")).toEqual({ key: "corroboration", label: "2 sources report this", value: 3 });
      // 3 × log2(3) = 4.75…
      expect(baseScore(input({ sourceCount: 3 })).base).toBe(74.8);
      expect(baseScore(input({ sourceCount: 4 })).base).toBe(76);
    });

    it("has the limit +6", () => {
      expect(baseScore(input({ sourceCount: 5 })).base).toBe(76);
      expect(baseScore(input({ sourceCount: 40 })).base).toBe(76);
    });

    it("is zero for a source count of 0", () => {
      expect(baseScore(input({ sourceCount: 0 })).base).toBe(70);
    });
  });

  describe("N: novelty", () => {
    it("new 0, update -3, repeat -10", () => {
      expect(baseScore(input({ novelty: "new" })).base).toBe(70);
      const update = baseScore(input({ novelty: "update" }));
      expect(update.base).toBe(67);
      expect(part(update.parts, "novelty")).toEqual({ key: "novelty", label: "An update of a known development", value: -3 });
      const repeat = baseScore(input({ novelty: "repeat" }));
      expect(repeat.base).toBe(60);
      expect(part(repeat.parts, "novelty")?.label).toBe("A repeat of a known development");
    });
  });

  describe("D: depth fit", () => {
    it("overview: always 0", () => {
      for (const depth of ["basic", "intermediate", "advanced"] as const) {
        expect(baseScore(input({ feedDepth: "overview", depth })).base).toBe(70);
      }
    });

    it("practitioner: basic -6", () => {
      expect(baseScore(input({ feedDepth: "practitioner", depth: "basic" })).base).toBe(64);
      expect(baseScore(input({ feedDepth: "practitioner", depth: "intermediate" })).base).toBe(70);
      expect(baseScore(input({ feedDepth: "practitioner", depth: "advanced" })).base).toBe(70);
    });

    it("deep: basic -12, intermediate -3", () => {
      const basic = baseScore(input({ feedDepth: "deep", depth: "basic" }));
      expect(basic.base).toBe(58);
      expect(part(basic.parts, "depth")?.value).toBe(-12);
      expect(part(basic.parts, "depth")?.label).toContain("Basic content");
      expect(baseScore(input({ feedDepth: "deep", depth: "intermediate" })).base).toBe(67);
      expect(baseScore(input({ feedDepth: "deep", depth: "advanced" })).base).toBe(70);
    });
  });

  describe("F: votes on the story", () => {
    it("useful +6 each, at most +12", () => {
      expect(baseScore(input({ votes: votes({ useful: 1 }) })).base).toBe(76);
      expect(baseScore(input({ votes: votes({ useful: 2 }) })).base).toBe(82);
      expect(baseScore(input({ votes: votes({ useful: 7 }) })).base).toBe(82);
    });

    it("already_knew -6 each, at most -12", () => {
      expect(baseScore(input({ votes: votes({ already_knew: 1 }) })).base).toBe(64);
      expect(baseScore(input({ votes: votes({ already_knew: 2 }) })).base).toBe(58);
      expect(baseScore(input({ votes: votes({ already_knew: 7 }) })).base).toBe(58);
    });

    it("too_basic -8 each, at most -16", () => {
      expect(baseScore(input({ votes: votes({ too_basic: 1 }) })).base).toBe(62);
      expect(baseScore(input({ votes: votes({ too_basic: 2 }) })).base).toBe(54);
      expect(baseScore(input({ votes: votes({ too_basic: 7 }) })).base).toBe(54);
    });

    it("off_topic -10 each, at most -20", () => {
      expect(baseScore(input({ votes: votes({ off_topic: 1 }) })).base).toBe(60);
      expect(baseScore(input({ votes: votes({ off_topic: 2 }) })).base).toBe(50);
      expect(baseScore(input({ votes: votes({ off_topic: 7 }) })).base).toBe(50);
    });

    it("adds the reasons, each with its own limit, in one part", () => {
      const result = baseScore(input({ votes: votes({ useful: 3, already_knew: 1, too_basic: 1, off_topic: 3 }) }));
      // +12 - 6 - 8 - 20 = -22
      expect(result.base).toBe(48);
      expect(part(result.parts, "votes")).toEqual({
        key: "votes",
        label: "Votes of the team on this story",
        value: -22,
        detail: "3 useful, 1 already knew this, 1 too basic, 3 off topic",
      });
    });

    it("has no part when votes cancel out", () => {
      const result = baseScore(input({ votes: votes({ useful: 1, already_knew: 1 }) }));
      expect(result.base).toBe(70);
      expect(part(result.parts, "votes")).toBeUndefined();
    });
  });

  it("never goes below 0", () => {
    const result = baseScore(
      input({
        relevance: 5,
        novelty: "repeat",
        feedDepth: "deep",
        depth: "basic",
        sourcePriority: "low",
        votes: votes({ off_topic: 2 }),
      }),
    );
    expect(result.base).toBe(0);
    // The parts still explain the terms.
    expect(result.parts.map((p) => p.key)).toEqual(["relevance", "source_priority", "novelty", "depth", "votes"]);
  });

  it("clamps the relevance to 0..100", () => {
    expect(baseScore(input({ relevance: 140 })).base).toBe(100);
    expect(baseScore(input({ relevance: -3 })).base).toBe(0);
  });

  it("lists the relevance first and then each term that is not zero, in the order of the formula", () => {
    const result = baseScore(
      input({
        relevance: 80,
        topicPriorities: ["high"],
        topicNames: ["Coding agents"],
        priorities: { practical: "strong", experiment: "normal", other: "" },
        signals: { practical: 3, experiment: 1 },
        sourcePriority: "high",
        sourceQuality: { useful: 4, offTopic: 1, tooBasic: 0 },
        sourceCount: 3,
        novelty: "update",
        feedDepth: "deep",
        depth: "intermediate",
        votes: votes({ useful: 1 }),
      }),
    );
    expect(result.parts.map((p) => p.key)).toEqual([
      "relevance",
      "topic",
      "priorities",
      "source_priority",
      "source_quality",
      "corroboration",
      "novelty",
      "depth",
      "votes",
    ]);
    for (const p of result.parts) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.value).not.toBe(0);
      expect(Math.round(p.value * 10) / 10).toBe(p.value);
    }
    // 80 + 8 + (2×1.5 - 0.5)×4/3 + 5 + (5/7 - 0.5)×10 + 3×log2(3) - 3 - 3 + 6
    const exact = 80 + 8 + (2.5 * 4) / 3 + 5 + (5 / 7 - 0.5) * 10 + 3 * Math.log2(3) - 3 - 3 + 6;
    expect(result.base).toBe(Math.round(exact * 10) / 10);
  });

  it("does not change its input", () => {
    const value = input({ topicPriorities: ["high"], topicNames: ["A"], votes: votes({ useful: 1 }) });
    const copy = JSON.parse(JSON.stringify(value)) as RankInput;
    baseScore(value);
    hiddenReason(value);
    expect(value).toEqual(copy);
  });
});

describe("effectiveHalfLife (§8.3)", () => {
  it("today ×1, week ×3, month ×10", () => {
    expect(effectiveHalfLife(48, "today")).toBe(48);
    expect(effectiveHalfLife(48, "week")).toBe(144);
    expect(effectiveHalfLife(48, "month")).toBe(480);
  });
});

describe("decayedScore (§8.3)", () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 10, 20, 12, 0);

  it("has factor 1 at age 0", () => {
    expect(decayedScore(80, now, 48, now)).toEqual({ score: 80, ageHours: 0, factor: 1 });
  });

  it("halves the score after one half-life", () => {
    const result = decayedScore(80, now - 48 * HOUR, 48, now);
    expect(result.ageHours).toBe(48);
    expect(result.factor).toBeCloseTo(0.5, 12);
    expect(result.score).toBeCloseTo(40, 10);
    expect(decayedScore(80, now - 96 * HOUR, 48, now).score).toBeCloseTo(20, 10);
  });

  it("gives the example of the specification: 20 h old, effective half-life 144 h, × 0.91", () => {
    const result = decayedScore(70, now - 20 * HOUR, effectiveHalfLife(48, "week"), now);
    expect(result.ageHours).toBe(20);
    expect(result.factor.toFixed(2)).toBe("0.91");
    expect(result.score).toBeCloseTo(70 * Math.pow(0.5, 20 / 144), 10);
  });

  it("treats a story from the future as age 0", () => {
    expect(decayedScore(50, now + 5 * HOUR, 48, now)).toEqual({ score: 50, ageHours: 0, factor: 1 });
  });

  it("does not divide by a half-life of 0", () => {
    const result = decayedScore(50, now - HOUR, 0, now);
    expect(result.factor).toBe(1);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});
