// The seed of the first run (specification §12).
//
// Contract (see openDatabase in src/lib/db/client.ts):
// - The database client calls runSeed(db) after the migrations, inside one
//   IMMEDIATE transaction, and only when the settings row `seeded_at` is
//   absent. runSeed returns true when the database holds the seed.
// - runSeed writes the `seeded_at` row itself, and each insert skips a row
//   that exists (unique slug or key), so a second call adds nothing.
// - No network call and no model call: the source configs are stored as
//   they are (with the schema defaults).
import { eq, inArray } from "drizzle-orm";

import { parseConfig, sourceKey } from "@/lib/connectors/configs";
import type { Db } from "@/lib/db/client";
import { feedSources, feedTopics, feeds, settings, sources, topics } from "@/lib/db/schema";
import { slugify } from "@/lib/text/words";
import { nowMs } from "@/lib/time";
import {
  DEFAULT_BRIEF_FORMAT,
  DEFAULT_EXCLUSIONS,
  DEFAULT_RELEVANCE_PRIORITIES,
  EMPTY_BRIEF_FORMAT_OVERRIDE,
  EMPTY_TEAM_PROFILE,
  SOURCE_TYPE_DEFAULTS,
  defaultFeedDefaults,
  type BriefFormatOverride,
  type Priority,
  type RelevancePriorities,
  type SettingsKey,
  type SourceType,
} from "@/lib/types";

import { SUGGESTION_FEED_SLUGS } from "./suggestions";

export const SEED_ACTOR = "Starter set";

export const SEED_TEAM_PROFILE = {
  ...EMPTY_TEAM_PROFILE,
  whatWeDo:
    "Software engineering with agentic development: projects for internal teams, and an in-house AI app for the organization.",
};

export const SEED_TOPICS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "Coding agents", description: "Agents that write, change, and review code, for example Claude Code, Codex, and Copilot." },
  { name: "Agent workflows", description: "How teams plan, run, and check work that agents do: patterns, hand-offs, and tools." },
  { name: "Testing and evaluations", description: "Tests, benchmarks, and evaluation methods for agents and model output." },
  { name: "Document processing", description: "Extraction, parsing, and understanding of documents with models." },
  { name: "Microsoft Foundry", description: "The Microsoft Foundry platform: agents, models, tools, and changes to the service." },
  { name: "Permissions and data access", description: "How agents and AI apps get access to data: identity, permissions, and governance." },
  { name: "Orchestration", description: "Frameworks and protocols that connect models, tools, and agents, for example MCP." },
  { name: "Enterprise deployment", description: "AI apps in a company: networking, security, compliance, cost, and operations." },
  { name: "Model releases", description: "New models and model versions, with their capabilities and limits." },
  { name: "Company announcements", description: "Product, pricing, and strategy news from AI companies and vendors." },
];

interface SeedFeed {
  slug: string;
  name: string;
  purpose: string;
  highTopics: string[];
  priorities: Omit<RelevancePriorities, "other">;
  briefFormat: BriefFormatOverride;
  halfLifeHours?: number;
  minRelevance?: number;
  alertRule: string;
}

export const SEED_FEEDS: readonly SeedFeed[] = [
  {
    slug: SUGGESTION_FEED_SLUGS.agenticDevelopment,
    name: "Agentic Development",
    purpose: "Coding agents, agent workflows, testing, and evaluations for projects built with agents.",
    highTopics: ["Coding agents", "Agent workflows", "Testing and evaluations"],
    priorities: { practical: "strong", experiment: "normal" },
    briefFormat: { ...EMPTY_BRIEF_FORMAT_OVERRIDE },
    alertRule:
      "A security problem or a breaking change in a coding agent or an agent tool that this feed follows; a major release of a coding agent.",
  },
  {
    slug: SUGGESTION_FEED_SLUGS.internalAiPlatform,
    name: "Internal AI Platform",
    purpose: "Foundry, permissions, data access, and orchestration for the in-house AI app.",
    highTopics: ["Microsoft Foundry", "Permissions and data access", "Orchestration", "Enterprise deployment"],
    priorities: { practical: "normal", experiment: "normal" },
    briefFormat: { ...EMPTY_BRIEF_FORMAT_OVERRIDE },
    alertRule:
      "A deprecation, a breaking change, or a security notice that affects Microsoft Foundry or the way teams get access to data.",
  },
  {
    slug: SUGGESTION_FEED_SLUGS.industryRadar,
    name: "Industry Radar",
    purpose: "Broader developments from podcasts, X, and company announcements that can change the direction of the tracked projects.",
    highTopics: ["Model releases", "Company announcements"],
    priorities: { practical: "normal", experiment: "normal" },
    briefFormat: { ...EMPTY_BRIEF_FORMAT_OVERRIDE, technicalDepth: "overview" },
    halfLifeHours: 36,
    // A radar shows the "worth knowing" stories too (relevance band 50-69).
    minRelevance: 50,
    alertRule: "",
  },
];

interface SeedSource {
  type: SourceType;
  name: string;
  url: string;
  config: unknown;
  why: string;
  feedSlug: string;
  priority: Priority;
  follow: string;
  ignore: string;
}

export const SEED_SOURCES: readonly SeedSource[] = [
  {
    type: "x_user",
    name: "@chamath",
    url: "https://x.com/chamath",
    config: { username: "chamath", includeReposts: false },
    why: "A first X account of the starter set.",
    feedSlug: SUGGESTION_FEED_SLUGS.industryRadar,
    priority: "normal",
    follow: "",
    ignore: "",
  },
  {
    type: "podcast",
    name: "All-In",
    url: "https://podcasts.apple.com/podcast/id1502871393",
    config: {
      feedUrl: "https://rss.libsyn.com/shows/254861/destinations/1928300.xml",
      show: "All-In with Chamath, Jason, Sacks & Friedberg",
      itunesId: 1502871393,
      transcripts: true,
    },
    why: "The first podcast of the starter set.",
    feedSlug: SUGGESTION_FEED_SLUGS.industryRadar,
    priority: "normal",
    follow: "",
    ignore: "",
  },
  {
    type: "docs",
    name: "Microsoft Foundry: What's new",
    url: "https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry",
    config: { url: "https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry", mode: "auto", ignoreMinorEdits: true },
    why: "Directly affects the internal AI app.",
    feedSlug: SUGGESTION_FEED_SLUGS.internalAiPlatform,
    priority: "high",
    follow: "agents, permissions, private networking",
    ignore: "cosmetic documentation edits",
  },
];

function seedSettings(db: Db, now: number): void {
  const values: Array<[SettingsKey, unknown]> = [
    ["team_profile", SEED_TEAM_PROFILE],
    ["brief_defaults", { ...DEFAULT_BRIEF_FORMAT }],
    ["default_exclusions", [...DEFAULT_EXCLUSIONS]],
    ["feed_defaults", defaultFeedDefaults()],
  ];
  for (const [key, value] of values) {
    db.insert(settings).values({ key, value, updatedAt: now, updatedBy: SEED_ACTOR }).onConflictDoNothing().run();
  }
}

function seedTopics(db: Db, now: number): Map<string, number> {
  for (const topic of SEED_TOPICS) {
    db.insert(topics)
      .values({ slug: slugify(topic.name), name: topic.name, description: topic.description, createdAt: now, createdBy: SEED_ACTOR })
      .onConflictDoNothing()
      .run();
  }
  const rows = db
    .select({ id: topics.id, name: topics.name })
    .from(topics)
    .where(inArray(topics.slug, SEED_TOPICS.map((topic) => slugify(topic.name))))
    .all();
  return new Map(rows.map((row) => [row.name, row.id]));
}

function seedFeeds(db: Db, now: number, topicIds: Map<string, number>): Map<string, number> {
  const defaults = defaultFeedDefaults();
  const feedIds = new Map<string, number>();
  SEED_FEEDS.forEach((feed, index) => {
    const inserted = db
      .insert(feeds)
      .values({
        slug: feed.slug,
        name: feed.name,
        purpose: feed.purpose,
        projectContext: "",
        position: index + 1,
        minRelevance: feed.minRelevance ?? defaults.minRelevance,
        halfLifeHours: feed.halfLifeHours ?? defaults.halfLifeHours,
        exclusions: [...DEFAULT_EXCLUSIONS],
        relevancePriorities: { ...DEFAULT_RELEVANCE_PRIORITIES, ...feed.priorities },
        briefFormat: feed.briefFormat,
        digest: defaults.digest,
        quietHours: defaults.quietHours,
        // Alerts are off: the rule text is a suggestion that a person can switch on.
        alerts: { ...defaults.alerts, enabled: false, rule: feed.alertRule },
        createdAt: now,
        createdBy: SEED_ACTOR,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: feeds.id })
      .get();
    const id = inserted?.id ?? db.select({ id: feeds.id }).from(feeds).where(eq(feeds.slug, feed.slug)).get()?.id;
    if (id === undefined) return;
    feedIds.set(feed.slug, id);
    if (!inserted) return; // an existing feed keeps its own topic priorities
    for (const name of feed.highTopics) {
      const topicId = topicIds.get(name);
      if (topicId !== undefined) db.insert(feedTopics).values({ feedId: id, topicId, priority: "high" }).onConflictDoNothing().run();
    }
  });
  return feedIds;
}

function seedSources(db: Db, now: number, feedIds: Map<string, number>): void {
  for (const source of SEED_SOURCES) {
    const config = parseConfig(source.type, source.config);
    const inserted = db
      .insert(sources)
      .values({
        type: source.type,
        key: sourceKey(source.type, config),
        name: source.name,
        url: source.url,
        config,
        why: source.why,
        addedBy: SEED_ACTOR,
        checkIntervalMinutes: SOURCE_TYPE_DEFAULTS[source.type].intervalMinutes,
        nextCheckAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: sources.id })
      .get();
    const feedId = feedIds.get(source.feedSlug);
    if (!inserted || feedId === undefined) continue;
    db.insert(feedSources)
      .values({
        feedId,
        sourceId: inserted.id,
        priority: source.priority,
        follow: source.follow,
        ignore: source.ignore,
        addedBy: SEED_ACTOR,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
}

export function runSeed(db: Db): boolean {
  db.transaction(
    () => {
      if (db.select({ key: settings.key }).from(settings).where(eq(settings.key, "seeded_at")).get()) return;
      const now = nowMs();
      seedSettings(db, now);
      const topicIds = seedTopics(db, now);
      const feedIds = seedFeeds(db, now, topicIds);
      seedSources(db, now, feedIds);
      db.insert(settings).values({ key: "seeded_at", value: now, updatedAt: now, updatedBy: SEED_ACTOR }).onConflictDoNothing().run();
    },
    { behavior: "immediate" },
  );
  return true;
}

export { STARTER_SUGGESTIONS } from "./suggestions";
