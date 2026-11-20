// The ranking of specification §8: pure functions, no database, no model call.
//
//   hiddenReason(input)   §8.1  is the judgement visible in the feed?
//   baseScore(input)      §8.2  the base score and its explanation (rank parts)
//   effectiveHalfLife()   §8.3  the half-life of a window
//   decayedScore()        §8.3  the score at read time
//
// The database helper that builds a RankInput is in ./recompute.ts.
import {
  LOW_SUBSTANCES,
  RELEVANCE_PRIORITY_LABELS,
  RELEVANCE_WEIGHT_LABELS,
  RELEVANCE_WEIGHT_VALUE,
  type Depth,
  type FeedbackReason,
  type HiddenReason,
  type Novelty,
  type Priority,
  type RankPart,
  type RelevancePriorities,
  type Signals,
  type Substance,
  type TechnicalDepth,
  type TopicPriority,
} from "@/lib/types";

export interface RankInput {
  relevance: number;
  exclusion: string | null;
  substance: Substance;
  /** Of the matched topics (no row = 'normal'). */
  topicPriorities: TopicPriority[];
  /** For labels. */
  topicNames: string[];
  signals: Signals;
  priorities: RelevancePriorities;
  /** S: highest priority among the story's sources that are in the feed; null = none in feed. */
  sourcePriority: Priority | null;
  /** Q input of the best source; null = none. */
  sourceQuality: { useful: number; offTopic: number; tooBasic: number } | null;
  sourceCount: number;
  novelty: Novelty;
  depth: Depth;
  feedDepth: TechnicalDepth;
  votes: Record<FeedbackReason, number>;
  minRelevance: number;
}

export type RankWindow = "today" | "week" | "month";

/** The vote counts that the term Q uses for one source (§8.2). */
export type SourceQualityInput = { useful: number; offTopic: number; tooBasic: number };

// --- limits of §8.2 ----------------------------------------------------------

const TOPIC_POINTS = 8;
const SOURCE_PRIORITY_POINTS: Record<Priority, number> = { high: 5, normal: 0, low: -5 };
const QUALITY_MIN_VOTES = 3;
const CORROBORATION_MAX = 6;
const NOVELTY_POINTS: Record<Novelty, number> = { new: 0, update: -3, repeat: -10 };
const DEPTH_POINTS: Record<TechnicalDepth, Record<Depth, number>> = {
  overview: { basic: 0, intermediate: 0, advanced: 0 },
  practitioner: { basic: -6, intermediate: 0, advanced: 0 },
  deep: { basic: -12, intermediate: -3, advanced: 0 },
};
/** Points for each vote and the limit of the sum, for each reason. */
const VOTE_POINTS: Record<FeedbackReason, { each: number; max: number }> = {
  useful: { each: 6, max: 12 },
  already_knew: { each: -6, max: 12 },
  too_basic: { each: -8, max: 16 },
  off_topic: { each: -10, max: 20 },
};
const WINDOW_FACTOR: Record<RankWindow, number> = { today: 1, week: 3, month: 10 };
const HOUR_MS = 3_600_000;

// --- small helpers -----------------------------------------------------------

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finite(value, min)));
}

/** A vote count: a whole number that is not negative. */
function count(value: number | undefined): number {
  return Math.max(0, Math.floor(finite(value ?? 0)));
}

function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded; // no -0
}

// --- §8.1 ----------------------------------------------------------------------

/**
 * §8.1. Null = visible. The order of the tests is the order of the
 * specification; the first reason that applies wins.
 */
export function hiddenReason(input: RankInput): HiddenReason | null {
  const useful = count(input.votes.useful);
  const offTopic = count(input.votes.off_topic);
  const tooBasic = count(input.votes.too_basic);
  const neg = offTopic + tooBasic;
  /** "Useful" votes outnumber the negative votes: the team rescued the story. */
  const rescued = useful > neg;

  // 1. No item of the story is from a source that is in the feed now.
  if (input.sourcePriority === null) return "source_removed";
  // 2. Two votes of one negative reason that outnumber "useful".
  if ((offTopic >= 2 && offTopic > useful) || (tooBasic >= 2 && tooBasic > useful)) return "feedback";
  // 3. An exclusion phrase or the Ignore text of the source matched.
  if (input.exclusion !== null && input.exclusion !== "" && !rescued) return "exclusion";
  // 4. A matched topic is muted in the feed.
  if (input.topicPriorities.includes("muted")) return "muted_topic";
  // 5. Marketing or opinion with no new information.
  if (LOW_SUBSTANCES.includes(input.substance) && !rescued) return "low_substance";
  // 6. Below the minimum relevance of the feed.
  if (input.relevance < input.minRelevance && !rescued) return "below_threshold";
  return null;
}

// --- §8.2 ----------------------------------------------------------------------

/**
 * The q value of one source (§8.2): 0 with fewer than 3 votes, else
 * ((useful + 1) / (n + 2) - 0.5) × 10, with n = useful + off_topic + too_basic.
 * The range is -5 < q < +5.
 */
export function sourceQualityScore(quality: SourceQualityInput | null): number {
  if (!quality) return 0;
  const useful = count(quality.useful);
  const n = useful + count(quality.offTopic) + count(quality.tooBasic);
  if (n < QUALITY_MIN_VOTES) return 0;
  return ((useful + 1) / (n + 2) - 0.5) * 10;
}

type Term = { key: string; label: string; value: number; detail?: string };

function topicTerm(input: RankInput): Term | null {
  const highIndex = input.topicPriorities.indexOf("high");
  if (highIndex >= 0) {
    const name = input.topicNames[highIndex];
    return {
      key: "topic",
      label: name ? `Topic "${name}" is high priority` : "A matched topic is high priority",
      value: TOPIC_POINTS,
    };
  }
  if (input.topicPriorities.length > 0 && input.topicPriorities.every((priority) => priority === "low")) {
    const name = input.topicNames[0];
    return {
      key: "topic",
      label:
        input.topicPriorities.length === 1 && name
          ? `Topic "${name}" is low priority`
          : "All matched topics are low priority",
      value: -TOPIC_POINTS,
    };
  }
  return null;
}

function prioritiesTerm(input: RankInput): Term | null {
  const keys = ["practical", "experiment"] as const;
  let value = 0;
  const details: string[] = [];
  for (const key of keys) {
    const weightName = input.priorities[key];
    const weight = RELEVANCE_WEIGHT_VALUE[weightName] ?? 0;
    if (weight === 0) continue;
    const signal = clamp(input.signals[key], 0, 3);
    value += (weight * (signal - 1.5) * 4) / 3;
    details.push(`${RELEVANCE_PRIORITY_LABELS[key]} (${RELEVANCE_WEIGHT_LABELS[weightName].toLowerCase()}): ${signal} of 3`);
  }
  if (details.length === 0) return null;
  return {
    key: "priorities",
    label: value >= 0 ? "Fits the relevance priorities of the feed" : "Weak fit with the relevance priorities of the feed",
    value,
    detail: details.join("; "),
  };
}

function sourcePriorityTerm(input: RankInput): Term | null {
  if (input.sourcePriority === null) return null;
  const value = SOURCE_PRIORITY_POINTS[input.sourcePriority] ?? 0;
  return { key: "source_priority", label: `A source with ${input.sourcePriority} priority in this feed`, value };
}

function sourceQualityTerm(input: RankInput): Term | null {
  const quality = input.sourceQuality;
  if (!quality) return null;
  const value = sourceQualityScore(quality);
  return {
    key: "source_quality",
    label:
      value >= 0
        ? "The team often finds stories of this source useful"
        : "The team often votes against stories of this source",
    value,
    detail: `Votes of the last 90 days: ${count(quality.useful)} useful, ${count(quality.offTopic)} off topic, ${count(quality.tooBasic)} too basic`,
  };
}

function corroborationTerm(input: RankInput): Term | null {
  const sources = Math.floor(finite(input.sourceCount));
  if (sources < 2) return null;
  return {
    key: "corroboration",
    label: `${sources} sources report this`,
    value: Math.min(CORROBORATION_MAX, 3 * Math.log2(sources)),
  };
}

function noveltyTerm(input: RankInput): Term | null {
  const value = NOVELTY_POINTS[input.novelty] ?? 0;
  if (input.novelty === "update") return { key: "novelty", label: "An update of a known development", value };
  if (input.novelty === "repeat") return { key: "novelty", label: "A repeat of a known development", value };
  return null;
}

function depthTerm(input: RankInput): Term | null {
  const value = DEPTH_POINTS[input.feedDepth]?.[input.depth] ?? 0;
  if (value === 0) return null;
  const level = input.depth === "basic" ? "Basic" : "Intermediate";
  return { key: "depth", label: `${level} content for a feed with technical depth "${input.feedDepth}"`, value };
}

function votesTerm(input: RankInput): Term | null {
  const names: Record<FeedbackReason, string> = {
    useful: "useful",
    already_knew: "already knew this",
    too_basic: "too basic",
    off_topic: "off topic",
  };
  let value = 0;
  const details: string[] = [];
  for (const reason of ["useful", "already_knew", "too_basic", "off_topic"] as const) {
    const n = count(input.votes[reason]);
    if (n === 0) continue;
    const { each, max } = VOTE_POINTS[reason];
    value += Math.sign(each) * Math.min(max, Math.abs(each) * n);
    details.push(`${n} ${names[reason]}`);
  }
  if (details.length === 0) return null;
  return { key: "votes", label: "Votes of the team on this story", value, detail: details.join(", ") };
}

/**
 * §8.2. `base` = the relevance plus the terms T, P, S, Q, C, N, D, and F,
 * never below 0, rounded to 1 decimal. `parts` = the relevance and each term
 * that is not zero, in the order of the formula, each value rounded to
 * 1 decimal (§8.3).
 */
export function baseScore(input: RankInput): { base: number; parts: RankPart[] } {
  const relevance = clamp(input.relevance, 0, 100);
  const terms = [
    topicTerm(input),
    prioritiesTerm(input),
    sourcePriorityTerm(input),
    sourceQualityTerm(input),
    corroborationTerm(input),
    noveltyTerm(input),
    depthTerm(input),
    votesTerm(input),
  ];

  const parts: RankPart[] = [{ key: "relevance", label: "Relevance", value: relevance }];
  let sum = relevance;
  for (const term of terms) {
    if (!term) continue;
    sum += term.value;
    const value = round1(term.value);
    if (value === 0) continue;
    parts.push({ key: term.key, label: term.label, value, ...(term.detail ? { detail: term.detail } : {}) });
  }
  return { base: round1(Math.max(0, sum)), parts };
}

// --- §8.3 ----------------------------------------------------------------------

/** today ×1, week ×3, month ×10 (§8.3). */
export function effectiveHalfLife(halfLifeHours: number, window: RankWindow): number {
  return halfLifeHours * (WINDOW_FACTOR[window] ?? 1);
}

/**
 * score = base × 0.5 ^ (age_hours / half_life) (§8.3). `halfLifeHours` is the
 * effective half-life of the window. A story from the future has age 0.
 */
export function decayedScore(
  base: number,
  freshAt: number,
  halfLifeHours: number,
  now: number,
): { score: number; ageHours: number; factor: number } {
  const ageHours = Math.max(0, finite(now - freshAt) / HOUR_MS);
  const halfLife = finite(halfLifeHours);
  const factor = halfLife > 0 ? Math.pow(0.5, ageHours / halfLife) : 1;
  return { score: base * factor, ageHours, factor };
}
