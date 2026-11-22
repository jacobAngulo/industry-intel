// Shared settings: shared feed profile, topics, defaults (specification §4.9, §8.4, §18.2).
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, getSqlite } from "@/lib/db/client";
import { topics, type TopicDbRow } from "@/lib/db/schema";
import { readBriefDefaults, recomputeJudgements } from "@/lib/ranking/recompute";
import { nowMs } from "@/lib/time";
import { DEFAULT_EXCLUSIONS, EMPTY_TEAM_PROFILE, defaultFeedDefaults, type BriefFormat, type FeedDefaults, type TeamProfile } from "@/lib/types";
import { briefFormatSchema, exclusionsSchema, feedDefaultsSchema, nameSchema, oneLineSchema, teamProfileSchema } from "@/lib/form-schemas";

import { RANK_TIME_RECOMPUTE_MS, inImmediate, q, readSetting, uniqueSlug, writeSetting } from "./_manage-db";
import { notFound, parseOrThrow, ServiceError } from "./_manage-errors";
import { logActivity } from "./activity";
import type { Actor, TopicRow } from "./types";

export interface SharedDefaults {
  briefDefaults: BriefFormat;
  defaultExclusions: string[];
  feedDefaults: FeedDefaults;
}

// ---------------------------------------------------------------------------
// Shared feed profile (judge-time, §8.4)
// ---------------------------------------------------------------------------

/** A stored profile with a missing or broken field reads that field as "". */
const storedProfileSchema = z.object({
  whatWeDo: z.string().catch(""),
  constraints: z.string().catch(""),
});

export async function getTeamProfile(): Promise<TeamProfile> {
  return readSetting("team_profile", storedProfileSchema, () => ({ ...EMPTY_TEAM_PROFILE }));
}

export async function updateTeamProfile(input: TeamProfile, actor: Actor): Promise<void> {
  const data = parseOrThrow(teamProfileSchema, input);
  inImmediate(() => {
    writeSetting("team_profile", data, actor.name.trim());
    logActivity(actor, "settings.team_profile", "settings", null, "Changed the shared feed profile.");
  });
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

function toTopicRow(row: TopicDbRow): TopicRow {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, archived: row.archivedAt !== null };
}

/** In the order of creation (the seed order first). */
export async function listTopics(opts?: { includeArchived?: boolean }): Promise<TopicRow[]> {
  return getDb()
    .select()
    .from(topics)
    .where(opts?.includeArchived ? undefined : isNull(topics.archivedAt))
    .orderBy(asc(topics.id))
    .all()
    .map(toTopicRow);
}

const topicSchema = z.object({ name: nameSchema, description: oneLineSchema });

/** Topic names are unique (no case difference), so that a feed's list is not ambiguous. */
function assertNameFree(name: string, exceptId: number | null): void {
  const clash = getDb()
    .select({ id: topics.id })
    .from(topics)
    .where(and(sql`lower(${topics.name}) = lower(${name})`, exceptId === null ? undefined : ne(topics.id, exceptId)))
    .get();
  if (clash) throw new ServiceError("conflict", `A topic with the name "${name}" exists already.`, { name: "Use another name." });
}

function requireTopic(id: number): TopicDbRow {
  const row = Number.isInteger(id) ? getDb().select().from(topics).where(eq(topics.id, id)).get() : undefined;
  if (!row) throw notFound("The topic");
  return row;
}

/** A new topic is judge-time (§8.4): no recompute. */
export async function createTopic(input: { name: string; description: string }, actor: Actor): Promise<TopicRow> {
  const data = parseOrThrow(topicSchema, input);
  return inImmediate(() => {
    assertNameFree(data.name, null);
    const row = getDb()
      .insert(topics)
      .values({ slug: uniqueSlug("topics", data.name), name: data.name, description: data.description, createdAt: nowMs(), createdBy: actor.name.trim() })
      .returning()
      .get();
    logActivity(actor, "topic.create", "topic", row.id, `Added the topic ${q(row.name)}.`);
    return toTopicRow(row);
  });
}

/** The slug stays. A new name changes the labels of the rank parts, so they are recomputed. */
export async function updateTopic(id: number, input: { name: string; description: string }, actor: Actor): Promise<void> {
  const data = parseOrThrow(topicSchema, input);
  inImmediate(() => {
    const topic = requireTopic(id);
    assertNameFree(data.name, id);
    getDb().update(topics).set(data).where(eq(topics.id, id)).run();
    if (data.name !== topic.name) recomputeJudgements({ sinceMs: RANK_TIME_RECOMPUTE_MS });
    logActivity(actor, "topic.update", "topic", id, `Changed the topic ${q(data.name)}.`);
  });
}

/** An archived topic no longer counts in the rank (no T term, no mute): recompute (§8.4). */
export async function archiveTopic(id: number, actor: Actor): Promise<void> {
  inImmediate(() => {
    const topic = requireTopic(id);
    if (topic.archivedAt !== null) return;
    getDb().update(topics).set({ archivedAt: nowMs() }).where(eq(topics.id, id)).run();
    recomputeJudgements({ sinceMs: RANK_TIME_RECOMPUTE_MS });
    logActivity(actor, "topic.archive", "topic", id, `Archived the topic ${q(topic.name)}.`);
  });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export async function getDefaults(): Promise<SharedDefaults> {
  return {
    briefDefaults: readBriefDefaults(),
    defaultExclusions: readSetting("default_exclusions", exclusionsSchema, () => [...DEFAULT_EXCLUSIONS]),
    feedDefaults: readSetting("feed_defaults", feedDefaultsSchema, () => defaultFeedDefaults()),
  };
}

const defaultsSchema = z.object({
  briefDefaults: briefFormatSchema,
  defaultExclusions: exclusionsSchema,
  feedDefaults: feedDefaultsSchema,
});

/** The ids of the feeds whose technical depth is the shared default. */
function feedsOnDefaultDepth(): number[] {
  const rows = getSqlite()
    .prepare("SELECT id FROM feeds WHERE json_extract(brief_format, '$.technicalDepth') IS NULL")
    .all() as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * The default technical depth is rank-time for the feeds that use it (the
 * term D, §8.4): after a change, their rank of the last 30 days is recomputed.
 */
export async function updateDefaults(input: SharedDefaults, actor: Actor): Promise<void> {
  const data = parseOrThrow(defaultsSchema, input);
  inImmediate(() => {
    const depthBefore = readBriefDefaults().technicalDepth;
    const by = actor.name.trim();
    writeSetting("brief_defaults", data.briefDefaults, by);
    writeSetting("default_exclusions", data.defaultExclusions, by);
    writeSetting("feed_defaults", data.feedDefaults, by);
    if (data.briefDefaults.technicalDepth !== depthBefore) {
      for (const feedId of feedsOnDefaultDepth()) recomputeJudgements({ feedId, sinceMs: RANK_TIME_RECOMPUTE_MS });
    }
    logActivity(actor, "settings.defaults", "settings", null, "Changed the shared defaults (brief format, exclusions, new feeds).");
  });
}
