// Domain types, enums, labels, and defaults. This module has no database, no
// Node import, and no zod, so the web process, the worker, and client
// components can all import it cheaply. The zod schemas of the shapes that
// people edit in forms are in src/lib/form-schemas.ts.
//
// JSON columns use camelCase keys (specification §5). Model input and output
// use snake_case: see src/lib/pipeline/schemas.ts.

// ---------------------------------------------------------------------------
// Sources and items (§6.1)
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  "x_user",
  "x_search",
  "podcast",
  "blog",
  "github",
  "docs",
  "newsletter",
  "youtube",
  "community",
  "research",
  "web_search",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  x_user: "X user",
  x_search: "X keyword",
  podcast: "Podcast",
  blog: "Engineering blog",
  github: "GitHub repository",
  docs: "Documentation / changelog",
  newsletter: "Newsletter",
  youtube: "YouTube",
  community: "Community",
  research: "Research",
  web_search: "Web search",
};

/** Default check interval (minutes) and the maximum age of an item (days) for each type. */
export const SOURCE_TYPE_DEFAULTS: Record<SourceType, { intervalMinutes: number; maxAgeDays: number }> = {
  x_user: { intervalMinutes: 60, maxAgeDays: 3 },
  x_search: { intervalMinutes: 720, maxAgeDays: 3 },
  podcast: { intervalMinutes: 180, maxAgeDays: 14 },
  blog: { intervalMinutes: 60, maxAgeDays: 7 },
  github: { intervalMinutes: 120, maxAgeDays: 10 },
  // Page changes have no publish date.
  docs: { intervalMinutes: 360, maxAgeDays: 3650 },
  newsletter: { intervalMinutes: 120, maxAgeDays: 7 },
  youtube: { intervalMinutes: 180, maxAgeDays: 10 },
  community: { intervalMinutes: 60, maxAgeDays: 3 },
  research: { intervalMinutes: 720, maxAgeDays: 14 },
  // Search results have no date.
  web_search: { intervalMinutes: 1440, maxAgeDays: 3650 },
};

export const ITEM_KINDS = [
  "post",
  "episode",
  "article",
  "release",
  "discussion",
  "advisory",
  "doc_change",
  "email",
  "video",
  "thread",
  "paper",
  "search_result",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  post: "Post",
  episode: "Episode",
  article: "Article",
  release: "Release",
  discussion: "Discussion",
  advisory: "Security advisory",
  doc_change: "Documentation change",
  email: "Email",
  video: "Video",
  thread: "Thread",
  paper: "Paper",
  search_result: "Search result",
};

export const JUDGE_STATUSES = ["pending", "judged", "skipped", "failed"] as const;
export type JudgeStatus = (typeof JUDGE_STATUSES)[number];

/** Values of items.skip_reason (§7.2). */
export const SKIP_REASONS = ["baseline", "empty", "too_old", "first_run_cap", "no_feed"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// ---------------------------------------------------------------------------
// Priorities, feedback, visibility
// ---------------------------------------------------------------------------

export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { high: "High", normal: "Normal", low: "Low" };

export const TOPIC_PRIORITIES = ["high", "normal", "low", "muted"] as const;
export type TopicPriority = (typeof TOPIC_PRIORITIES)[number];
export const TOPIC_PRIORITY_LABELS: Record<TopicPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
  muted: "Muted",
};

export const FEEDBACK_REASONS = ["useful", "too_basic", "off_topic", "already_knew"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  useful: "Useful",
  too_basic: "Too basic",
  off_topic: "Off topic",
  already_knew: "Already knew this",
};

/** A new vote count record with zero for each reason. */
export function emptyVotes(): Record<FeedbackReason, number> {
  return { useful: 0, too_basic: 0, off_topic: 0, already_knew: 0 };
}

/** Stored hidden reasons, in the evaluation order of §8.1. Null = visible. */
export const HIDDEN_REASONS = [
  "source_removed",
  "feedback",
  "exclusion",
  "muted_topic",
  "low_substance",
  "below_threshold",
] as const;
export type HiddenReason = (typeof HIDDEN_REASONS)[number];
export const HIDDEN_REASON_LABELS: Record<HiddenReason, string> = {
  source_removed: "No source of this feed",
  feedback: "Team feedback",
  exclusion: "Exclusion",
  muted_topic: "Muted topic",
  low_substance: "Low substance",
  below_threshold: "Below the minimum relevance",
};

// ---------------------------------------------------------------------------
// Story facts from the judge call (§7.3)
// ---------------------------------------------------------------------------

/** Highest substance first: news > report > analysis > promo > chatter. */
export const SUBSTANCES = ["news", "report", "analysis", "promo", "chatter"] as const;
export type Substance = (typeof SUBSTANCES)[number];
export const SUBSTANCE_ORDER: readonly Substance[] = SUBSTANCES;

/** A larger number is a higher substance (news = 4 … chatter = 0). */
export function substanceRank(substance: Substance): number {
  return SUBSTANCES.length - 1 - SUBSTANCES.indexOf(substance);
}

/** True when `a` is a higher substance than `b`. */
export function isHigherSubstance(a: Substance, b: Substance): boolean {
  return substanceRank(a) > substanceRank(b);
}

/** Substance values that hide a story by default (§8.1 rule 5). */
export const LOW_SUBSTANCES: readonly Substance[] = ["promo", "chatter"];

export const STORY_CATEGORIES = [
  "release",
  "feature",
  "model",
  "tool",
  "security",
  "research",
  "practice",
  "opinion",
  "business",
  "discussion",
  "other",
] as const;
export type StoryCategory = (typeof STORY_CATEGORIES)[number];
export const STORY_CATEGORY_LABELS: Record<StoryCategory, string> = {
  release: "Release",
  feature: "Feature",
  model: "Model",
  tool: "Tool",
  security: "Security",
  research: "Research",
  practice: "Practice",
  opinion: "Opinion",
  business: "Business",
  discussion: "Discussion",
  other: "Other",
};

export const NOVELTIES = ["new", "update", "repeat"] as const;
export type Novelty = (typeof NOVELTIES)[number];

export const DEPTHS = ["basic", "intermediate", "advanced"] as const;
export type Depth = (typeof DEPTHS)[number];

/** Integers 0..3 from the model (JSON keys in camelCase). */
export interface Signals {
  practical: number;
  experiment: number;
}

/** One line of the rank explanation (§8.3). */
export interface RankPart {
  key: string;
  label: string;
  value: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Brief format (§9.1)
// ---------------------------------------------------------------------------

export const SUMMARY_LENGTHS = ["short", "standard", "detailed"] as const;
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number];
export const SUMMARY_LENGTH_LABELS: Record<SummaryLength, string> = {
  short: "Short",
  standard: "Standard",
  detailed: "Detailed",
};
/** The number of summary sentences that a card shows. */
export const SUMMARY_SENTENCES: Record<SummaryLength, number> = { short: 1, standard: 3, detailed: 5 };

export const TECHNICAL_DEPTHS = ["overview", "practitioner", "deep"] as const;
export type TechnicalDepth = (typeof TECHNICAL_DEPTHS)[number];
export const TECHNICAL_DEPTH_LABELS: Record<TechnicalDepth, string> = {
  overview: "Overview",
  practitioner: "Practitioner",
  deep: "Deep",
};

export interface BriefFormat {
  summaryLength: SummaryLength;
  technicalDepth: TechnicalDepth;
  suggestedActions: boolean;
}

/** The value of one feed. A null field = use the shared default. */
export interface BriefFormatOverride {
  summaryLength: SummaryLength | null;
  technicalDepth: TechnicalDepth | null;
  suggestedActions: boolean | null;
}

export const DEFAULT_BRIEF_FORMAT: BriefFormat = {
  summaryLength: "standard",
  technicalDepth: "practitioner",
  suggestedActions: true,
};

export const EMPTY_BRIEF_FORMAT_OVERRIDE: BriefFormatOverride = {
  summaryLength: null,
  technicalDepth: null,
  suggestedActions: null,
};

/** Effective format of a feed = the feed value, or the shared default when null. */
export function effectiveBriefFormat(override: BriefFormatOverride, defaults: BriefFormat): BriefFormat {
  return {
    summaryLength: override.summaryLength ?? defaults.summaryLength,
    technicalDepth: override.technicalDepth ?? defaults.technicalDepth,
    suggestedActions: override.suggestedActions ?? defaults.suggestedActions,
  };
}

// ---------------------------------------------------------------------------
// Shared feed profile and feed settings
// ---------------------------------------------------------------------------

export interface TeamProfile {
  whatWeDo: string;
  constraints: string;
}

export const EMPTY_TEAM_PROFILE: TeamProfile = {
  whatWeDo: "",
  constraints: "",
};

export const RELEVANCE_WEIGHTS = ["off", "normal", "strong"] as const;
export type RelevanceWeight = (typeof RELEVANCE_WEIGHTS)[number];
export const RELEVANCE_WEIGHT_LABELS: Record<RelevanceWeight, string> = {
  off: "Off",
  normal: "Normal",
  strong: "Strong",
};
/** The number that the base score uses for the term P (§8.2). */
export const RELEVANCE_WEIGHT_VALUE: Record<RelevanceWeight, number> = { off: 0, normal: 1, strong: 2 };

export interface RelevancePriorities {
  /** "Practical implementation" */
  practical: RelevanceWeight;
  /** "Promising things to experiment with" */
  experiment: RelevanceWeight;
  /** The free text "Other priorities" (judge-time). */
  other: string;
}

export const RELEVANCE_PRIORITY_LABELS: Record<"practical" | "experiment", string> = {
  practical: "Practical implementation",
  experiment: "Promising things to experiment with",
};

export const DEFAULT_RELEVANCE_PRIORITIES: RelevancePriorities = {
  practical: "normal",
  experiment: "normal",
  other: "",
};

export const DIGEST_FREQUENCIES = ["off", "daily", "weekdays", "weekly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];
export const DIGEST_FREQUENCY_LABELS: Record<DigestFrequency, string> = {
  off: "Off",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
};

/** Weekday numbers: 0 = Sunday … 6 = Saturday (the same as Date.getDay()). */
export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface DigestSettings {
  frequency: DigestFrequency;
  /** 0 = Sunday … 6 = Saturday. Used only when the frequency is `weekly`. */
  weekday: number;
  /** Local time "HH:MM" (24 h) in `timeZone`. */
  time: string;
  /** IANA time zone name, for example "Europe/Berlin". */
  timeZone: string;
  maxStories: number;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" in the time zone of the digest settings. */
  start: string;
  /** "HH:MM". The period can cross midnight. start = end counts as off. */
  end: string;
}

export interface AlertSettings {
  enabled: boolean;
  /** "Which developments deserve an immediate alert?" */
  rule: string;
  minRelevance: number;
}

/** The values that a new feed starts from (settings key `feed_defaults`). */
export interface FeedDefaults {
  minRelevance: number;
  halfLifeHours: number;
  digest: DigestSettings;
  quietHours: QuietHours;
  alerts: AlertSettings;
}

/** The IANA time zone of this server process ("UTC" when the runtime does not say). */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const DEFAULT_MIN_RELEVANCE = 60;
export const DEFAULT_HALF_LIFE_HOURS = 48;
export const DEFAULT_ALERT_MIN_RELEVANCE = 85;
export const DEFAULT_DIGEST_MAX_STORIES = 10;

/** The defaults of §12. A function, because the time zone is the zone of the server. */
export function defaultFeedDefaults(timeZone: string = serverTimeZone()): FeedDefaults {
  return {
    minRelevance: DEFAULT_MIN_RELEVANCE,
    halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
    digest: { frequency: "weekdays", weekday: 1, time: "08:30", timeZone, maxStories: DEFAULT_DIGEST_MAX_STORIES },
    quietHours: { enabled: false, start: "18:00", end: "08:00" },
    alerts: { enabled: false, rule: "", minRelevance: DEFAULT_ALERT_MIN_RELEVANCE },
  };
}

export const DEFAULT_EXCLUSIONS: readonly string[] = [
  "Politics",
  "Funding announcements",
  "Beginner tutorials",
  "Repeated launch coverage",
];

/** Relevance labels of the story card: High >= 80, Medium 60-79, Low < 60. */
export function relevanceLabel(relevance: number): "High" | "Medium" | "Low" {
  if (relevance >= 80) return "High";
  if (relevance >= 60) return "Medium";
  return "Low";
}

// ---------------------------------------------------------------------------
// Digest and analysis (stored JSON)
// ---------------------------------------------------------------------------

/** One entry of a digest: a snapshot of the brief at the time of the digest (§4.4, §9.2). */
export interface DigestEntry {
  storyId: number;
  headline: string;
  /** The full summary. The page cuts it to the summary length of the feed. */
  summary: string[];
  whyItMatters: string;
  suggestedAction: string | null;
  relevance: number;
  baseScore: number;
  primaryUrl: string | null;
  category: StoryCategory;
  freshAt: number;
}

export const EFFORTS = ["quick_check", "experiment", "project"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABELS: Record<Effort, string> = {
  quick_check: "Quick check",
  experiment: "Experiment",
  project: "Project",
};

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface AnalysisAction {
  action: string;
  why: string;
  effort: Effort;
  firstStep: string;
}

/** The deeper analysis (§7.5), stored in analyses.content. */
export interface AnalysisContent {
  whatChanged: string[];
  howItWorks: string[];
  whatItMeansForUs: string[];
  risksAndLimits: string[];
  suggestedActions: AnalysisAction[];
  openQuestions: string[];
  confidence: Confidence;
  confidenceNote: string;
  sourcesUsed: string[];
}

export const WORK_STATUSES = ["queued", "running", "done", "failed"] as const;
/** Status of an analysis row and of a re-judge request. */
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Values of analyses.stage while the row is `running` (§7.5). */
export const ANALYSIS_STAGES = ["Reading the sources", "Writing"] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

// ---------------------------------------------------------------------------
// Usage, events, worker state
// ---------------------------------------------------------------------------

export const USAGE_METRICS = [
  "llm_calls",
  "llm_calls_preview",
  "llm_input_tokens",
  "llm_output_tokens",
  "x_posts",
  "x_users",
  "web_searches",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/** worker_state key `heartbeat`. */
export interface WorkerHeartbeat {
  at: number;
  hasModelKey: boolean;
  hasXToken: boolean;
  hasMailbox: boolean;
}

/** worker_state key `worker_lease`. */
export interface WorkerLease {
  id: string;
  expiresAt: number;
}

export const WORKER_STATE_KEYS = [
  "heartbeat",
  "worker_lease",
  "llm_paused_until",
  "llm_pause_step",
  "llm_last_error",
] as const;
export type WorkerStateKey = (typeof WORKER_STATE_KEYS)[number];

export const SETTINGS_KEYS = [
  "team_profile",
  "brief_defaults",
  "default_exclusions",
  "feed_defaults",
  "seeded_at",
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** The worker is alive when its heartbeat is newer than this (§4.10). */
export const WORKER_ALIVE_MS = 30_000;

// ---------------------------------------------------------------------------
// Limits (§14). The zod schemas that use them are in src/lib/form-schemas.ts.
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Names: feed, topic, source, display name. */
  name: 120,
  /** One-line fields: purpose, why it matters, an exclusion phrase, Follow / Ignore, the alert rule. */
  oneLine: 300,
  /** Multi-line fields: context, the shared feed profile fields, "Other priorities". */
  multiLine: 4000,
  /** Entries in a list: exclusions, sections, domains. */
  listEntries: 50,
  maxSources: 500,
  maxFeeds: 30,
} as const;
