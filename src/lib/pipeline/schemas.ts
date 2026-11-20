// The output schemas of the model calls (specification §7.3 and §7.5), in
// snake_case as the model sees them, and the functions that clean a parsed
// reply.
//
// How the limits work:
// - The zod schemas check the STRUCTURE (types, enum values, required
//   fields). A reply that fails here gets the repair retry of the provider.
// - The LIMITS (string lengths, integer ranges, list sizes) are in the JSON
//   schema that the model sees (`z.toJSONSchema(schema)`), through `.meta()`.
//   zod does not enforce them: the clean functions clamp and truncate, so a
//   headline of 115 characters does not cost a second model call.
import { z } from "zod";

import {
  CONFIDENCES,
  DEPTHS,
  EFFORTS,
  NOVELTIES,
  STORY_CATEGORIES,
  SUBSTANCES,
  type AnalysisContent,
  type Depth,
  type Novelty,
  type Signals,
  type StoryCategory,
  type Substance,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const JUDGE_LIMITS = {
  headline: 110,
  summaryMin: 1,
  summaryMax: 5,
  /** Not in the specification: a guard against one endless "sentence". */
  summarySentence: 600,
  entities: 8,
  entity: 80,
  reason: 200,
  whyItMatters: 240,
  suggestedAction: 200,
  exclusion: 300,
  relevanceMax: 100,
  signalMax: 3,
} as const;

export const ANALYSIS_LIMITS = {
  paragraphs: 12,
  paragraph: 4000,
  actions: 8,
  actionText: 500,
  openQuestions: 10,
  openQuestion: 600,
  confidenceNote: 1000,
  sourcesUsed: 20,
} as const;

/** The value of `exclusion` when the Ignore text of the source matches. */
export const SOURCE_FILTER_EXCLUSION = "source filter";

// ---------------------------------------------------------------------------
// Judge call (§7.3)
// ---------------------------------------------------------------------------

const integerMeta = (min: number, max: number, description?: string) => ({
  type: "integer" as const,
  minimum: min,
  maximum: max,
  ...(description ? { description } : {}),
});

export const judgeItemFactsSchema = z.object({
  headline: z.string().meta({
    maxLength: JUDGE_LIMITS.headline,
    description: "At most 110 characters. Calm and factual. No hype words, no emoji, no all-caps.",
  }),
  summary: z
    .array(z.string())
    .min(JUDGE_LIMITS.summaryMin)
    .meta({
      maxItems: JUDGE_LIMITS.summaryMax,
      description: "1 to 5 sentences, the most important first. Each sentence can stand alone. Only facts from the item.",
    }),
  category: z.enum(STORY_CATEGORIES),
  entities: z.array(z.string()).meta({
    maxItems: JUDGE_LIMITS.entities,
    description: "At most 8 names of products, companies, projects, or people that the item is about.",
  }),
  substance: z.enum(SUBSTANCES).meta({
    description:
      "news = a new fact; report = first-hand experience or data; analysis = reasoned commentary with information; promo = marketing or sponsorship; chatter = opinion with no new information.",
  }),
  same_story_id: z.number().nullable().meta({
    description: "The id of a candidate story only when the item is about the same event. Else null.",
  }),
  adds_new_facts: z.boolean().meta({ description: "Only meaningful when same_story_id is set." }),
});

export const judgeSignalsSchema = z.object({
  practical: z.number().meta(integerMeta(0, JUDGE_LIMITS.signalMax)),
  experiment: z.number().meta(integerMeta(0, JUDGE_LIMITS.signalMax)),
});

export const judgeFeedResultSchema = z.object({
  feed_id: z.number().meta({ type: "integer" }),
  relevance: z.number().meta(integerMeta(0, JUDGE_LIMITS.relevanceMax)),
  reason: z.string().meta({ maxLength: JUDGE_LIMITS.reason, description: "Why this score." }),
  why_it_matters: z.string().meta({
    maxLength: JUDGE_LIMITS.whyItMatters,
    description: "One sentence that names the link to the work of this feed.",
  }),
  suggested_action: z.string().nullable().meta({
    maxLength: JUDGE_LIMITS.suggestedAction,
    description: "One concrete step in the imperative, or null when there is nothing to do.",
  }),
  topic_ids: z.array(z.number()).meta({ description: "Ids of the topics of this feed that the item matches." }),
  exclusion: z.string().nullable().meta({
    description:
      'The exclusion phrase of the feed that the item matches, or "source filter" when the Ignore text of the source matches, else null.',
  }),
  novelty: z.enum(NOVELTIES),
  depth: z.enum(DEPTHS),
  signals: judgeSignalsSchema,
  alert: z.boolean(),
});

/** Normal mode: the facts of the item and one result for each feed. */
export const judgeNormalSchema = z.object({
  item: judgeItemFactsSchema,
  feeds: z.array(judgeFeedResultSchema),
});

/** Single-story mode: the story exists; the model returns only feed results. */
export const judgeSingleStorySchema = z.object({
  feeds: z.array(judgeFeedResultSchema),
});

export type JudgeItemFactsRaw = z.infer<typeof judgeItemFactsSchema>;
export type JudgeFeedResultRaw = z.infer<typeof judgeFeedResultSchema>;
export type JudgeNormalRaw = z.infer<typeof judgeNormalSchema>;
export type JudgeSingleStoryRaw = z.infer<typeof judgeSingleStorySchema>;

function requireFeeds(feedIds: readonly number[]) {
  return (value: { feeds: Array<{ feed_id: number }> }, ctx: z.RefinementCtx) => {
    const got = new Set(value.feeds.map((feed) => Math.round(feed.feed_id)));
    const missing = feedIds.filter((id) => !got.has(id));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["feeds"],
        message: `"feeds" must have one result for each requested feed. Missing feed_id: ${missing.join(", ")}.`,
      });
    }
  };
}

/**
 * The schema for one judge call in normal mode. It also fails when a
 * requested feed has no result (the provider then makes its repair retry;
 * after that the error kind is `bad_output`).
 */
export function judgeNormalSchemaFor(feedIds: readonly number[]): z.ZodType<JudgeNormalRaw> {
  return judgeNormalSchema.superRefine(requireFeeds(feedIds));
}

/** The schema for one judge call in single-story mode (see judgeNormalSchemaFor). */
export function judgeSingleStorySchemaFor(feedIds: readonly number[]): z.ZodType<JudgeSingleStoryRaw> {
  return judgeSingleStorySchema.superRefine(requireFeeds(feedIds));
}

// --- cleaned shapes ---------------------------------------------------------

export interface CleanItemFacts {
  headline: string;
  summary: string[];
  category: StoryCategory;
  entities: string[];
  substance: Substance;
  sameStoryId: number | null;
  addsNewFacts: boolean;
}

export interface CleanFeedResult {
  feedId: number;
  relevance: number;
  reason: string;
  whyItMatters: string;
  suggestedAction: string | null;
  topicIds: number[];
  exclusion: string | null;
  novelty: Novelty;
  depth: Depth;
  signals: Signals;
  alert: boolean;
}

export interface JudgeCleanContext {
  /** The feed ids that the call asked for. Results for other ids are dropped. */
  feedIds: readonly number[];
  /** The topic ids that exist (not archived). Other ids are dropped. */
  topicIds: readonly number[];
  /** The ids of the candidate stories of the call. Another same_story_id becomes null. */
  candidateStoryIds?: readonly number[];
}

export interface CleanJudgeOutput {
  /** Null in single-story mode. */
  item: CleanItemFacts | null;
  feeds: CleanFeedResult[];
  /** Requested feed ids that have no result. */
  missingFeedIds: number[];
}

// --- small text tools (private: src/lib/text belongs to another module) -----

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cuts to at most `max` characters. A cut text ends with "…" (inside the limit). */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Rounds to an integer and clamps to [min, max]. A value that is not a number gives `min`. */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Cleans the item facts: truncates, cuts the lists, and checks same_story_id against the candidates. */
export function cleanItemFacts(raw: JudgeItemFactsRaw, candidateStoryIds: readonly number[] = []): CleanItemFacts {
  const summary = raw.summary
    .map((sentence) => cutText(oneLine(sentence), JUDGE_LIMITS.summarySentence))
    .filter((sentence) => sentence.length > 0)
    .slice(0, JUDGE_LIMITS.summaryMax);
  const headline = cutText(oneLine(raw.headline), JUDGE_LIMITS.headline);
  const entities = uniqueStrings(raw.entities.map((entity) => cutText(oneLine(entity), JUDGE_LIMITS.entity))).slice(
    0,
    JUDGE_LIMITS.entities,
  );

  let sameStoryId: number | null = null;
  if (raw.same_story_id !== null && Number.isFinite(raw.same_story_id)) {
    const id = Math.round(raw.same_story_id);
    if (candidateStoryIds.includes(id)) sameStoryId = id;
  }

  return {
    headline,
    // A reply whose sentences are all empty keeps the headline as its one sentence.
    summary: summary.length > 0 ? summary : headline ? [headline] : [],
    category: raw.category,
    entities,
    substance: raw.substance,
    sameStoryId,
    addsNewFacts: sameStoryId !== null && raw.adds_new_facts,
  };
}

/** Converts the signals of the model to the stored camelCase shape (integers 0..3). */
export function toSignals(raw: z.infer<typeof judgeSignalsSchema>): Signals {
  return {
    practical: clampInt(raw.practical, 0, JUDGE_LIMITS.signalMax),
    experiment: clampInt(raw.experiment, 0, JUDGE_LIMITS.signalMax),
  };
}

/** Cleans one feed result: clamps the integers, truncates the strings, drops unknown topic ids. */
export function cleanFeedResult(raw: JudgeFeedResultRaw, topicIds: readonly number[]): CleanFeedResult {
  const known = new Set(topicIds);
  const topics: number[] = [];
  for (const value of raw.topic_ids) {
    const id = Math.round(value);
    if (Number.isFinite(value) && known.has(id) && !topics.includes(id)) topics.push(id);
  }

  const action = raw.suggested_action === null ? "" : oneLine(raw.suggested_action);
  const exclusion = raw.exclusion === null ? "" : oneLine(raw.exclusion);
  const noValue = (text: string) => text === "" || /^(null|none|n\/a)$/i.test(text);

  return {
    feedId: Math.round(raw.feed_id),
    relevance: clampInt(raw.relevance, 0, JUDGE_LIMITS.relevanceMax),
    reason: cutText(oneLine(raw.reason), JUDGE_LIMITS.reason),
    whyItMatters: cutText(oneLine(raw.why_it_matters), JUDGE_LIMITS.whyItMatters),
    suggestedAction: noValue(action) ? null : cutText(action, JUDGE_LIMITS.suggestedAction),
    topicIds: topics,
    exclusion: noValue(exclusion)
      ? null
      : exclusion.toLowerCase() === SOURCE_FILTER_EXCLUSION
        ? SOURCE_FILTER_EXCLUSION
        : cutText(exclusion, JUDGE_LIMITS.exclusion),
    novelty: raw.novelty,
    depth: raw.depth,
    signals: toSignals(raw.signals),
    alert: raw.alert,
  };
}

/**
 * Cleans a parsed judge reply (normal mode or single-story mode):
 * drops results for feeds that were not asked for (and a second result for
 * the same feed), then cleans each part. `missingFeedIds` lists the requested
 * feeds that have no result.
 */
export function cleanJudgeOutput(raw: JudgeNormalRaw | JudgeSingleStoryRaw, ctx: JudgeCleanContext): CleanJudgeOutput {
  const asked = new Set(ctx.feedIds);
  const seen = new Set<number>();
  const feeds: CleanFeedResult[] = [];
  for (const result of raw.feeds) {
    const feedId = Math.round(result.feed_id);
    if (!asked.has(feedId) || seen.has(feedId)) continue;
    seen.add(feedId);
    feeds.push(cleanFeedResult(result, ctx.topicIds));
  }
  return {
    item: "item" in raw && raw.item ? cleanItemFacts(raw.item, ctx.candidateStoryIds ?? []) : null,
    feeds,
    missingFeedIds: ctx.feedIds.filter((id) => !seen.has(id)),
  };
}

// ---------------------------------------------------------------------------
// Analysis (§7.5)
// ---------------------------------------------------------------------------

const paragraphs = (description: string) =>
  z.array(z.string()).meta({ maxItems: ANALYSIS_LIMITS.paragraphs, description });

export const analysisSchema = z.object({
  what_changed: paragraphs("Paragraphs."),
  how_it_works: paragraphs("Paragraphs. Can be empty when the sources do not say."),
  what_it_means_for_us: paragraphs("Paragraphs, specific to the shared feed profile and the feed context."),
  risks_and_limits: paragraphs("Paragraphs."),
  suggested_actions: z
    .array(
      z.object({
        action: z.string().meta({ maxLength: ANALYSIS_LIMITS.actionText }),
        why: z.string().meta({ maxLength: ANALYSIS_LIMITS.actionText }),
        effort: z.enum(EFFORTS),
        first_step: z.string().meta({ maxLength: ANALYSIS_LIMITS.actionText }),
      }),
    )
    .meta({ maxItems: ANALYSIS_LIMITS.actions }),
  open_questions: z.array(z.string()).meta({ maxItems: ANALYSIS_LIMITS.openQuestions }),
  confidence: z.enum(CONFIDENCES),
  confidence_note: z.string().meta({
    maxLength: ANALYSIS_LIMITS.confidenceNote,
    description: "What the sources do not say.",
  }),
  sources_used: z.array(z.string()).meta({ description: "URLs. Only URLs from the allowed list." }),
});

export type AnalysisRaw = z.infer<typeof analysisSchema>;

export interface AnalysisCleanContext {
  /** The allowed source URLs of the call. Other URLs are dropped. */
  allowedUrls: readonly string[];
  /** False when the feed has suggested actions off: the action list becomes empty. */
  suggestedActions: boolean;
}

/** For the comparison with the allowed list only: no fragment, no trailing slash, lower-case scheme and host. */
function urlKey(url: string): string {
  const raw = url.trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function cleanParagraphs(values: string[], maxItems: number, maxLength: number): string[] {
  return values
    .map((value) => cutText(value.trim(), maxLength))
    .filter((value) => value.length > 0)
    .slice(0, maxItems);
}

/**
 * Cleans a parsed analysis reply and converts it to the stored camelCase
 * shape: truncates, cuts the lists, drops the URLs that are not in the
 * allowed list (the allowed spelling is kept), and empties the action list
 * when the feed has suggested actions off.
 */
export function toAnalysisContent(raw: AnalysisRaw, ctx: AnalysisCleanContext): AnalysisContent {
  const allowed = new Map<string, string>();
  for (const url of ctx.allowedUrls) if (!allowed.has(urlKey(url))) allowed.set(urlKey(url), url);

  const sourcesUsed: string[] = [];
  for (const url of raw.sources_used) {
    const match = allowed.get(urlKey(url));
    if (match && !sourcesUsed.includes(match)) sourcesUsed.push(match);
  }

  const actions = ctx.suggestedActions
    ? raw.suggested_actions
        .map((entry) => ({
          action: cutText(oneLine(entry.action), ANALYSIS_LIMITS.actionText),
          why: cutText(oneLine(entry.why), ANALYSIS_LIMITS.actionText),
          effort: entry.effort,
          firstStep: cutText(oneLine(entry.first_step), ANALYSIS_LIMITS.actionText),
        }))
        .filter((entry) => entry.action.length > 0)
        .slice(0, ANALYSIS_LIMITS.actions)
    : [];

  return {
    whatChanged: cleanParagraphs(raw.what_changed, ANALYSIS_LIMITS.paragraphs, ANALYSIS_LIMITS.paragraph),
    howItWorks: cleanParagraphs(raw.how_it_works, ANALYSIS_LIMITS.paragraphs, ANALYSIS_LIMITS.paragraph),
    whatItMeansForUs: cleanParagraphs(raw.what_it_means_for_us, ANALYSIS_LIMITS.paragraphs, ANALYSIS_LIMITS.paragraph),
    risksAndLimits: cleanParagraphs(raw.risks_and_limits, ANALYSIS_LIMITS.paragraphs, ANALYSIS_LIMITS.paragraph),
    suggestedActions: actions,
    openQuestions: cleanParagraphs(raw.open_questions, ANALYSIS_LIMITS.openQuestions, ANALYSIS_LIMITS.openQuestion),
    confidence: raw.confidence,
    confidenceNote: cutText(raw.confidence_note.trim(), ANALYSIS_LIMITS.confidenceNote),
    sourcesUsed: sourcesUsed.slice(0, ANALYSIS_LIMITS.sourcesUsed),
  };
}
