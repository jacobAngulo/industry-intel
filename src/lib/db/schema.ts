// The data model of specification §5.
//
// Conventions: integer autoincrement primary keys named `id`. Times are
// integers (UTC epoch milliseconds) in columns that end in `_at`. SQL names
// are snake_case; drizzle properties are camelCase. JSON columns are text
// with `{ mode: "json" }`. Foreign keys cascade on delete unless noted.
//
// After each change: `npm run db:generate -- --name=<name>`.
// The FTS5 table `stories_fts` is in a hand-written migration (see fts.ts).
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

import type {
  AlertSettings,
  AnalysisContent,
  BriefFormatOverride,
  Depth,
  DigestEntry,
  DigestSettings,
  EventLevel,
  FeedbackReason,
  HiddenReason,
  ItemKind,
  JudgeStatus,
  Novelty,
  Priority,
  QuietHours,
  RankPart,
  RelevancePriorities,
  Signals,
  SourceType,
  StoryCategory,
  Substance,
  TopicPriority,
  UsageMetric,
  WorkStatus,
} from "@/lib/types";

const id = () => integer("id").primaryKey({ autoIncrement: true });

// ---------------------------------------------------------------------------
// People and access (specification §15)
// Ops Console reads both tables (deploy/manifest.toml, [product_ops]), so the
// SQL names `user` and `access_request` are a contract.

/** One Google account. `id` is the Google subject: it stays the same when the email changes. */
export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  image: text("image"),
  createdAt: integer("created_at").notNull(),
  lastSignInAt: integer("last_sign_in_at").notNull(),
});

/** One row for each account that asked for access. A new request after a denial updates the row. */
export const accessRequests = sqliteTable(
  "access_request",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    note: text("note"),
    status: text("status", { enum: ["pending", "approved", "denied"] }).notNull().default("pending"),
    decidedAt: integer("decided_at"),
    // Free text: the operator who decides has no row in `user`.
    decidedBy: text("decided_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("access_request_user_unique").on(t.userId),
    index("access_request_status_idx").on(t.status, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Shared settings and topics
// ---------------------------------------------------------------------------

/**
 * Keys: team_profile (TeamProfile), brief_defaults (BriefFormat),
 * default_exclusions (string[]), feed_defaults (FeedDefaults), seeded_at (number),
 * api_keys ({ OLLAMA_API_KEY?, X_BEARER_TOKEN? }: saved API keys, see env.ts).
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull().default(""),
});

export const topics = sqliteTable(
  "topics",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull().default(""),
    archivedAt: integer("archived_at"),
  },
  (t) => [uniqueIndex("topics_slug_unique").on(t.slug)],
);

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export const feeds = sqliteTable(
  "feeds",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    projectContext: text("project_context").notNull().default(""),
    position: integer("position").notNull().default(0),
    minRelevance: integer("min_relevance").notNull().default(60),
    halfLifeHours: integer("half_life_hours").notNull().default(48),
    exclusions: text("exclusions", { mode: "json" }).$type<string[]>().notNull(),
    relevancePriorities: text("relevance_priorities", { mode: "json" }).$type<RelevancePriorities>().notNull(),
    /** Null fields = the shared default. */
    briefFormat: text("brief_format", { mode: "json" }).$type<BriefFormatOverride>().notNull(),
    digest: text("digest", { mode: "json" }).$type<DigestSettings>().notNull(),
    quietHours: text("quiet_hours", { mode: "json" }).$type<QuietHours>().notNull(),
    alerts: text("alerts", { mode: "json" }).$type<AlertSettings>().notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (t) => [uniqueIndex("feeds_slug_unique").on(t.slug), index("feeds_position_idx").on(t.position)],
);

/** No row = priority `normal`. */
export const feedTopics = sqliteTable(
  "feed_topics",
  {
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    priority: text("priority").$type<TopicPriority>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.feedId, t.topicId] }), index("feed_topics_topic_idx").on(t.topicId)],
);

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const sources = sqliteTable(
  "sources",
  {
    id: id(),
    type: text("type").$type<SourceType>().notNull(),
    /** The canonical identity (see sourceKey in src/lib/connectors/configs.ts). */
    key: text("key").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    config: text("config", { mode: "json" }).$type<unknown>().notNull(),
    why: text("why").notNull().default(""),
    addedBy: text("added_by").notNull().default(""),
    owner: text("owner"),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    checkIntervalMinutes: integer("check_interval_minutes").notNull(),
    cursor: text("cursor", { mode: "json" }).$type<unknown>(),
    nextCheckAt: integer("next_check_at").notNull().default(0),
    checkRequestedAt: integer("check_requested_at"),
    lockedUntil: integer("locked_until"),
    lastCheckedAt: integer("last_checked_at"),
    lastSuccessAt: integer("last_success_at"),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("sources_key_unique").on(t.key),
    index("sources_due_idx").on(t.paused, t.nextCheckAt),
    index("sources_type_idx").on(t.type),
  ],
);

export const sourceChecks = sqliteTable(
  "source_checks",
  {
    id: id(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    itemsFound: integer("items_found").notNull().default(0),
    itemsNew: integer("items_new").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("source_checks_source_idx").on(t.sourceId, t.startedAt)],
);

export const sourceFlags = sqliteTable(
  "source_flags",
  {
    id: id(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [index("source_flags_source_idx").on(t.sourceId, t.resolvedAt)],
);

export const feedSources = sqliteTable(
  "feed_sources",
  {
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    priority: text("priority").$type<Priority>().notNull().default("normal"),
    follow: text("follow").notNull().default(""),
    ignore: text("ignore").notNull().default(""),
    addedBy: text("added_by").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.feedId, t.sourceId] }), index("feed_sources_source_idx").on(t.sourceId)],
);

// ---------------------------------------------------------------------------
// Items and stories
// ---------------------------------------------------------------------------

export const items = sqliteTable(
  "items",
  {
    id: id(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url"),
    canonicalUrl: text("canonical_url"),
    title: text("title").notNull().default(""),
    author: text("author"),
    publishedAt: integer("published_at"),
    fetchedAt: integer("fetched_at").notNull(),
    kind: text("kind").$type<ItemKind>().notNull(),
    contentText: text("content_text").notNull().default(""),
    contentHash: text("content_hash").notNull().default(""),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    substance: text("substance").$type<Substance>(),
    /** SET NULL on delete. */
    storyId: integer("story_id").references((): AnySQLiteColumn => stories.id, { onDelete: "set null" }),
    judgeStatus: text("judge_status").$type<JudgeStatus>().notNull().default("pending"),
    /** A SkipReason value when judge_status is `skipped`. */
    skipReason: text("skip_reason"),
    judgeAttempts: integer("judge_attempts").notNull().default(0),
    judgeError: text("judge_error"),
    nextJudgeAt: integer("next_judge_at"),
    judgeLockedUntil: integer("judge_locked_until"),
    judgedAt: integer("judged_at"),
  },
  (t) => [
    uniqueIndex("items_source_external_unique").on(t.sourceId, t.externalId),
    index("items_canonical_url_idx").on(t.canonicalUrl),
    index("items_judge_idx").on(t.judgeStatus, t.nextJudgeAt),
    index("items_source_fetched_idx").on(t.sourceId, t.fetchedAt),
    index("items_story_idx").on(t.storyId),
  ],
);

export const itemLinks = sqliteTable(
  "item_links",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** Canonical URL. */
    url: text("url").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.url] }), index("item_links_url_idx").on(t.url)],
);

export const stories = sqliteTable(
  "stories",
  {
    id: id(),
    headline: text("headline").notNull(),
    summary: text("summary", { mode: "json" }).$type<string[]>().notNull(),
    category: text("category").$type<StoryCategory>().notNull(),
    entities: text("entities", { mode: "json" }).$type<string[]>().notNull(),
    substance: text("substance").$type<Substance>().notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastItemAt: integer("last_item_at").notNull(),
    /** The time that the rank decay and the windows use. It never moves back. */
    freshAt: integer("fresh_at").notNull(),
    itemCount: integer("item_count").notNull().default(1),
    sourceCount: integer("source_count").notNull().default(1),
    /** SET NULL on delete. */
    primaryItemId: integer("primary_item_id").references((): AnySQLiteColumn => items.id, { onDelete: "set null" }),
    primaryUrl: text("primary_url"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("stories_last_item_idx").on(t.lastItemAt), index("stories_fresh_idx").on(t.freshAt)],
);

// ---------------------------------------------------------------------------
// Judgements, feedback, analyses, digests, alerts, re-judge
// ---------------------------------------------------------------------------

export const judgements = sqliteTable(
  "judgements",
  {
    id: id(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    storyId: integer("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    relevance: integer("relevance").notNull(),
    reason: text("reason").notNull().default(""),
    whyItMatters: text("why_it_matters").notNull().default(""),
    suggestedAction: text("suggested_action"),
    topicIds: text("topic_ids", { mode: "json" }).$type<number[]>().notNull(),
    /** The matched exclusion phrase, or "source filter", or null. */
    exclusion: text("exclusion"),
    novelty: text("novelty").$type<Novelty>().notNull(),
    depth: text("depth").$type<Depth>().notNull(),
    signals: text("signals", { mode: "json" }).$type<Signals>().notNull(),
    alert: integer("alert", { mode: "boolean" }).notNull().default(false),
    baseScore: real("base_score").notNull().default(0),
    rankParts: text("rank_parts", { mode: "json" }).$type<RankPart[]>().notNull(),
    /** Null = visible. */
    hiddenReason: text("hidden_reason").$type<HiddenReason>(),
    /** The item that produced the judgement. SET NULL on delete. */
    sourceItemId: integer("source_item_id").references(() => items.id, { onDelete: "set null" }),
    model: text("model").notNull().default(""),
    /** The first insert. A replace keeps it. */
    createdAt: integer("created_at").notNull(),
    judgedAt: integer("judged_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("judgements_feed_story_unique").on(t.feedId, t.storyId),
    index("judgements_feed_hidden_score_idx").on(t.feedId, t.hiddenReason, t.baseScore),
    index("judgements_story_idx").on(t.storyId),
  ],
);

export const feedback = sqliteTable(
  "feedback",
  {
    id: id(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    storyId: integer("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    reason: text("reason").$type<FeedbackReason>().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("feedback_feed_story_user_unique").on(t.feedId, t.storyId, t.userId),
    index("feedback_story_idx").on(t.storyId),
    index("feedback_feed_created_idx").on(t.feedId, t.createdAt),
  ],
);

export const analyses = sqliteTable(
  "analyses",
  {
    id: id(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    storyId: integer("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    status: text("status").$type<WorkStatus>().notNull().default("queued"),
    stage: text("stage"),
    content: text("content", { mode: "json" }).$type<AnalysisContent>(),
    error: text("error"),
    model: text("model"),
    attempts: integer("attempts").notNull().default(0),
    requestedBy: text("requested_by").notNull().default(""),
    requestedAt: integer("requested_at").notNull(),
    startedAt: integer("started_at"),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    uniqueIndex("analyses_feed_story_unique").on(t.feedId, t.storyId),
    index("analyses_status_idx").on(t.status, t.requestedAt),
    index("analyses_story_idx").on(t.storyId),
  ],
);

export const digests = sqliteTable(
  "digests",
  {
    id: id(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    title: text("title").notNull(),
    entries: text("entries", { mode: "json" }).$type<DigestEntry[]>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("digests_feed_period_end_unique").on(t.feedId, t.periodEnd)],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: id(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    storyId: integer("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    visibleAt: integer("visible_at").notNull(),
  },
  (t) => [
    uniqueIndex("alerts_feed_story_unique").on(t.feedId, t.storyId),
    index("alerts_feed_visible_idx").on(t.feedId, t.visibleAt),
    index("alerts_story_idx").on(t.storyId),
  ],
);

export const rejudgeRequests = sqliteTable(
  "rejudge_requests",
  {
    id: id(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    /** Null = all sources of the feed. */
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "cascade" }),
    sinceAt: integer("since_at").notNull(),
    maxStories: integer("max_stories"),
    status: text("status").$type<WorkStatus>().notNull().default("queued"),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    requestedBy: text("requested_by").notNull().default(""),
    requestedAt: integer("requested_at").notNull(),
    startedAt: integer("started_at"),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("rejudge_requests_status_idx").on(t.status, t.requestedAt),
    index("rejudge_requests_feed_idx").on(t.feedId, t.requestedAt),
    index("rejudge_requests_source_idx").on(t.sourceId),
  ],
);

// ---------------------------------------------------------------------------
// Usage, events, activity, worker state
// ---------------------------------------------------------------------------

export const usageDaily = sqliteTable(
  "usage_daily",
  {
    /** 'YYYY-MM-DD' in UTC. */
    day: text("day").notNull(),
    metric: text("metric").$type<UsageMetric>().notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric] })],
);

/** Capped: the housekeeping keeps the newest 2000 rows. */
export const events = sqliteTable(
  "events",
  {
    id: id(),
    at: integer("at").notNull(),
    level: text("level").$type<EventLevel>().notNull(),
    scope: text("scope").notNull(),
    message: text("message").notNull(),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("events_at_idx").on(t.at), index("events_level_idx").on(t.level, t.at)],
);

export const activity = sqliteTable(
  "activity",
  {
    id: id(),
    at: integer("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    summary: text("summary").notNull().default(""),
  },
  (t) => [index("activity_at_idx").on(t.at)],
);

/**
 * Keys: heartbeat ({ at, hasModelKey, hasXToken, hasMailbox }),
 * worker_lease ({ id, expiresAt }), llm_paused_until (number),
 * llm_pause_step (number), llm_last_error (string).
 */
export const workerState = sqliteTable("worker_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type SettingRow = typeof settings.$inferSelect;
export type TopicDbRow = typeof topics.$inferSelect;
export type FeedDbRow = typeof feeds.$inferSelect;
export type NewFeedDbRow = typeof feeds.$inferInsert;
export type FeedTopicDbRow = typeof feedTopics.$inferSelect;
export type SourceDbRow = typeof sources.$inferSelect;
export type NewSourceDbRow = typeof sources.$inferInsert;
export type SourceCheckDbRow = typeof sourceChecks.$inferSelect;
export type SourceFlagDbRow = typeof sourceFlags.$inferSelect;
export type FeedSourceDbRow = typeof feedSources.$inferSelect;
export type ItemDbRow = typeof items.$inferSelect;
export type NewItemDbRow = typeof items.$inferInsert;
export type ItemLinkDbRow = typeof itemLinks.$inferSelect;
export type StoryDbRow = typeof stories.$inferSelect;
export type NewStoryDbRow = typeof stories.$inferInsert;
export type JudgementDbRow = typeof judgements.$inferSelect;
export type NewJudgementDbRow = typeof judgements.$inferInsert;
export type FeedbackDbRow = typeof feedback.$inferSelect;
export type AnalysisDbRow = typeof analyses.$inferSelect;
export type DigestDbRow = typeof digests.$inferSelect;
export type AlertDbRow = typeof alerts.$inferSelect;
export type RejudgeRequestDbRow = typeof rejudgeRequests.$inferSelect;
export type UsageDailyDbRow = typeof usageDaily.$inferSelect;
export type EventDbRow = typeof events.$inferSelect;
export type ActivityDbRow = typeof activity.$inferSelect;
export type WorkerStateDbRow = typeof workerState.$inferSelect;
