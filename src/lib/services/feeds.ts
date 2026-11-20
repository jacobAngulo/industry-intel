// Feeds and their settings (specification §4.8, §8.4, §9.3, §18.2).
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { z } from "zod";

import { getDb, getSqlite } from "@/lib/db/client";
import { feedSources, feedTopics, feeds, sources, topics, type FeedDbRow } from "@/lib/db/schema";
import { backfillFeedSource } from "@/lib/pipeline/jobs";
import { effectiveBriefFormatOf, readBriefDefaults, recomputeJudgements } from "@/lib/ranking/recompute";
import { HOUR_MS, nowMs } from "@/lib/time";
import { DEFAULT_EXCLUSIONS, DEFAULT_RELEVANCE_PRIORITIES, EMPTY_BRIEF_FORMAT_OVERRIDE, LIMITS, defaultFeedDefaults, type Priority, type TopicPriority } from "@/lib/types";
import { alertSettingsSchema, briefFormatOverrideSchema, digestSettingsSchema, exclusionsSchema, feedDefaultsSchema, halfLifeHoursSchema, minRelevanceSchema, multiLineSchema, nameSchema, oneLineSchema, prioritySchema, quietHoursSchema, relevancePrioritiesSchema, topicPrioritySchema } from "@/lib/form-schemas";

import {
  RANK_TIME_RECOMPUTE_MS,
  countRows,
  inImmediate,
  limitError,
  q,
  readSetting,
  requireFeed,
  uniqueSlug,
} from "./_manage-db";
import { notFound, parseOrThrow, requireName, ServiceError } from "./_manage-errors";
import { toSourceRows } from "./_manage-source-rows";
import { logActivity } from "./activity";
import type { Actor, FeedDeliveryPatch, FeedDetail, FeedInterestsPatch, FeedSummary, SourceRow } from "./types";

/** §9.3: an alert shows for at most 72 hours after visible_at. */
export const ALERT_SHOW_MS = 72 * HOUR_MS;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function sourceCounts(): Map<number, number> {
  const rows = getSqlite()
    .prepare("SELECT feed_id AS feedId, COUNT(*) AS n FROM feed_sources GROUP BY feed_id")
    .all() as Array<{ feedId: number; n: number }>;
  return new Map(rows.map((row) => [row.feedId, row.n]));
}

/**
 * The alerts that the UI shows now (§9.3): the judgement is visible, alerts
 * are on for the feed, visible_at <= now, and visible_at is at most 72 h ago.
 */
function visibleAlertIds(feed: FeedDbRow, now: number): number[] {
  if (feed.archivedAt !== null || !feed.alerts?.enabled) return [];
  const rows = getSqlite()
    .prepare(
      `SELECT a.id FROM alerts a JOIN judgements j ON j.feed_id = a.feed_id AND j.story_id = a.story_id
        WHERE a.feed_id = ? AND j.hidden_reason IS NULL AND a.visible_at <= ? AND a.visible_at >= ?
        ORDER BY a.visible_at DESC, a.id DESC`,
    )
    .all(feed.id, now, now - ALERT_SHOW_MS) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function toSummary(feed: FeedDbRow, counts: Map<number, number>, now: number): FeedSummary {
  return {
    id: feed.id,
    slug: feed.slug,
    name: feed.name,
    purpose: feed.purpose,
    position: feed.position,
    archived: feed.archivedAt !== null,
    sourceCount: counts.get(feed.id) ?? 0,
    alertIds: visibleAlertIds(feed, now),
  };
}

/** Active feeds in position order (with `includeArchived`, the archived ones too). */
export async function listFeeds(opts?: { includeArchived?: boolean }): Promise<FeedSummary[]> {
  const rows = getDb()
    .select()
    .from(feeds)
    .where(opts?.includeArchived ? undefined : isNull(feeds.archivedAt))
    .orderBy(asc(feeds.position), asc(feeds.id))
    .all();
  const counts = sourceCounts();
  const now = nowMs();
  return rows.map((feed) => toSummary(feed, counts, now));
}

function topicPrioritiesOf(feedId: number): Record<number, TopicPriority> {
  const out: Record<number, TopicPriority> = {};
  for (const row of getDb().select().from(feedTopics).where(eq(feedTopics.feedId, feedId)).all()) {
    out[row.topicId] = row.priority;
  }
  return out;
}

function toDetail(feed: FeedDbRow): FeedDetail {
  return {
    ...toSummary(feed, sourceCounts(), nowMs()),
    projectContext: feed.projectContext,
    minRelevance: feed.minRelevance,
    halfLifeHours: feed.halfLifeHours,
    exclusions: feed.exclusions,
    relevancePriorities: feed.relevancePriorities,
    briefFormat: feed.briefFormat,
    effectiveBriefFormat: effectiveBriefFormatOf(feed.briefFormat),
    digest: feed.digest,
    quietHours: feed.quietHours,
    alerts: feed.alerts,
    topicPriorities: topicPrioritiesOf(feed.id),
  };
}

/** The feed with this slug (archived feeds too), or null. */
export async function getFeedBySlug(slug: string): Promise<FeedDetail | null> {
  if (typeof slug !== "string" || !slug) return null;
  const feed = getDb().select().from(feeds).where(eq(feeds.slug, slug)).get();
  return feed ? toDetail(feed) : null;
}

/** Every source of the directory, with the link of this feed (§4.8 Sources). */
export async function listFeedSources(
  feedId: number,
): Promise<Array<{ source: SourceRow; included: boolean; priority: Priority; follow: string; ignore: string }>> {
  if (!Number.isInteger(feedId)) return [];
  const links = new Map(
    getDb()
      .select()
      .from(feedSources)
      .where(eq(feedSources.feedId, feedId))
      .all()
      .map((link) => [link.sourceId, link]),
  );
  const all = getDb().select().from(sources).orderBy(asc(sources.type), asc(sources.name), asc(sources.id)).all();
  return toSourceRows(all).map((source) => {
    const link = links.get(source.id);
    return {
      source,
      included: link !== undefined,
      priority: link?.priority ?? "normal",
      follow: link?.follow ?? "",
      ignore: link?.ignore ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Recomputes the rank of the judgements of the feed from the last 30 days (§8.4 rank-time). */
function recomputeFeed(feedId: number): void {
  recomputeJudgements({ feedId, sinceMs: RANK_TIME_RECOMPUTE_MS });
}

const createFeedSchema = z.object({ name: nameSchema, purpose: oneLineSchema });

/** A new feed starts from the shared feed_defaults and default_exclusions (§4.9, §12). */
export async function createFeed(input: { name: string; purpose: string }, actor: Actor): Promise<FeedDetail> {
  requireName(actor);
  const data = parseOrThrow(createFeedSchema, input);
  const id = inImmediate(() => {
    if (countRows("feeds") >= LIMITS.maxFeeds) {
      throw limitError(`The app has ${LIMITS.maxFeeds} feeds, the maximum. Delete an archived feed first.`);
    }
    const defaults = readSetting("feed_defaults", feedDefaultsSchema, () => defaultFeedDefaults());
    const exclusions = readSetting("default_exclusions", exclusionsSchema, () => [...DEFAULT_EXCLUSIONS]);
    const last = getDb().select({ position: max(feeds.position) }).from(feeds).get();
    const now = nowMs();
    const row = getDb()
      .insert(feeds)
      .values({
        slug: uniqueSlug("feeds", data.name),
        name: data.name,
        purpose: data.purpose,
        projectContext: "",
        position: (last?.position ?? 0) + 1,
        minRelevance: defaults.minRelevance,
        halfLifeHours: defaults.halfLifeHours,
        exclusions,
        relevancePriorities: { ...DEFAULT_RELEVANCE_PRIORITIES },
        briefFormat: { ...EMPTY_BRIEF_FORMAT_OVERRIDE },
        digest: defaults.digest,
        quietHours: defaults.quietHours,
        alerts: defaults.alerts,
        createdAt: now,
        createdBy: actor.name.trim(),
        updatedAt: now,
      })
      .returning({ id: feeds.id })
      .get();
    logActivity(actor, "feed.create", "feed", row.id, `Created the feed ${q(data.name)}.`);
    return row.id;
  });
  return toDetail(requireFeed(id));
}

const profileSchema = z.object({ name: nameSchema, purpose: oneLineSchema, projectContext: multiLineSchema });

/** Judge-time settings (§8.4): no recompute; the page offers the re-judge. The slug stays. */
export async function updateFeedProfile(
  feedId: number,
  input: { name: string; purpose: string; projectContext: string },
  actor: Actor,
): Promise<void> {
  requireName(actor);
  const data = parseOrThrow(profileSchema, input);
  inImmediate(() => {
    requireFeed(feedId);
    getDb().update(feeds).set({ ...data, updatedAt: nowMs() }).where(eq(feeds.id, feedId)).run();
    logActivity(actor, "feed.profile", "feed", feedId, `Changed the name, purpose, or context of the feed ${q(data.name)}.`);
  });
}

const interestsSchema = z
  .object({
    topicPriorities: z
      .record(z.string().regex(/^\d+$/, "Use a topic id."), topicPrioritySchema)
      .refine((value) => Object.keys(value).length <= 500, "Too many topics."),
    exclusions: exclusionsSchema,
    relevancePriorities: relevancePrioritiesSchema,
    minRelevance: minRelevanceSchema,
    halfLifeHours: halfLifeHoursSchema,
  })
  .partial();

/** The words of the activity log for each key of a partial save. */
const INTEREST_LABELS: Record<keyof FeedInterestsPatch, string> = {
  topicPriorities: "the topic priorities",
  exclusions: "the exclusions",
  relevancePriorities: "the relevance priorities",
  minRelevance: "the minimum relevance",
  halfLifeHours: "the half-life",
};
/** §8.4: these interests are rank-time. The half-life is read-time; the exclusions are judge-time. */
const RANK_TIME_INTERESTS: ReadonlySet<keyof FeedInterestsPatch> = new Set(["topicPriorities", "relevancePriorities", "minRelevance"]);

const DELIVERY_LABELS: Record<keyof FeedDeliveryPatch, string> = {
  briefFormat: "the brief format",
  digest: "the digest",
  quietHours: "the quiet hours",
  alerts: "the alerts",
};

/** "a", "a and b", "a, b, and c". */
function joinWords(words: string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A partial save of the Interests group (§4.8): only the keys of the input
 * change. The read, the merge, and the write run in one IMMEDIATE
 * transaction, so a save of one section never reverts a change that another
 * person saved in another section. `topicPriorities` holds only the changed
 * topics; a topic with priority `normal` has no feed_topics row, and a topic
 * that is not in the input keeps its row. When a rank-time value (§8.4)
 * changed, the rank of the last 30 days is recomputed at once. A save that
 * changes nothing writes nothing.
 */
export async function updateFeedInterests(feedId: number, input: FeedInterestsPatch, actor: Actor): Promise<void> {
  requireName(actor);
  const data = parseOrThrow(interestsSchema, input);
  inImmediate(() => {
    const feed = requireFeed(feedId);
    const changed: Array<keyof FeedInterestsPatch> = [];

    if (data.topicPriorities !== undefined) {
      const knownTopics = new Set(getDb().select({ id: topics.id }).from(topics).all().map((row) => row.id));
      const priorities = Object.entries(data.topicPriorities).map(([id, priority]) => ({ topicId: Number(id), priority }));
      const unknown = priorities.filter((entry) => !knownTopics.has(entry.topicId));
      if (unknown.length > 0) {
        throw new ServiceError(
          "validation",
          "A topic of the list does not exist.",
          Object.fromEntries(unknown.map((entry) => [`topicPriorities.${entry.topicId}`, "This topic does not exist."])),
        );
      }
      const current = new Map(
        getDb()
          .select({ topicId: feedTopics.topicId, priority: feedTopics.priority })
          .from(feedTopics)
          .where(eq(feedTopics.feedId, feedId))
          .all()
          .map((row) => [row.topicId, row.priority]),
      );
      for (const { topicId, priority } of priorities) {
        if ((current.get(topicId) ?? "normal") === priority) continue;
        if (!changed.includes("topicPriorities")) changed.push("topicPriorities");
        const where = and(eq(feedTopics.feedId, feedId), eq(feedTopics.topicId, topicId));
        if (priority === "normal") {
          getDb().delete(feedTopics).where(where).run();
        } else {
          getDb()
            .insert(feedTopics)
            .values({ feedId, topicId, priority })
            .onConflictDoUpdate({ target: [feedTopics.feedId, feedTopics.topicId], set: { priority } })
            .run();
        }
      }
    }

    const patch: Partial<Pick<FeedDbRow, "exclusions" | "relevancePriorities" | "minRelevance" | "halfLifeHours">> = {};
    if (data.exclusions !== undefined && !sameJson(data.exclusions, feed.exclusions)) {
      patch.exclusions = data.exclusions;
      changed.push("exclusions");
    }
    if (data.relevancePriorities !== undefined && !sameJson(data.relevancePriorities, feed.relevancePriorities)) {
      patch.relevancePriorities = data.relevancePriorities;
      changed.push("relevancePriorities");
    }
    if (data.minRelevance !== undefined && data.minRelevance !== feed.minRelevance) {
      patch.minRelevance = data.minRelevance;
      changed.push("minRelevance");
    }
    if (data.halfLifeHours !== undefined && data.halfLifeHours !== feed.halfLifeHours) {
      patch.halfLifeHours = data.halfLifeHours;
      changed.push("halfLifeHours");
    }
    if (changed.length === 0) return;

    getDb().update(feeds).set({ ...patch, updatedAt: nowMs() }).where(eq(feeds.id, feedId)).run();
    if (changed.some((key) => RANK_TIME_INTERESTS.has(key))) recomputeFeed(feedId);
    logActivity(
      actor,
      "feed.interests",
      "feed",
      feedId,
      `Changed ${joinWords(changed.map((key) => INTEREST_LABELS[key]))} of the feed ${q(feed.name)}.`,
    );
  });
}

const deliverySchema = z
  .object({
    briefFormat: briefFormatOverrideSchema,
    digest: digestSettingsSchema,
    quietHours: quietHoursSchema,
    alerts: alertSettingsSchema,
  })
  .partial();

/**
 * A partial save of the Delivery group (§4.8), merged like
 * updateFeedInterests. The digest time zone is checked with Intl
 * (timeZoneSchema). The technical depth is rank-time (the term D, §8.4):
 * when the effective depth of the merged brief format changes, the rank of
 * the last 30 days is recomputed.
 */
export async function updateFeedDelivery(feedId: number, input: FeedDeliveryPatch, actor: Actor): Promise<void> {
  requireName(actor);
  const data = parseOrThrow(deliverySchema, input);
  inImmediate(() => {
    const feed = requireFeed(feedId);
    const patch: Partial<Pick<FeedDbRow, "briefFormat" | "digest" | "quietHours" | "alerts">> = {};
    const changed: Array<keyof FeedDeliveryPatch> = [];
    for (const key of ["briefFormat", "digest", "quietHours", "alerts"] as const) {
      const value = data[key];
      if (value === undefined || sameJson(value, feed[key])) continue;
      Object.assign(patch, { [key]: value });
      changed.push(key);
    }
    if (changed.length === 0) return;

    const defaults = readBriefDefaults();
    const depthBefore = effectiveBriefFormatOf(feed.briefFormat, defaults).technicalDepth;
    const depthAfter = effectiveBriefFormatOf(patch.briefFormat ?? feed.briefFormat, defaults).technicalDepth;
    getDb().update(feeds).set({ ...patch, updatedAt: nowMs() }).where(eq(feeds.id, feedId)).run();
    if (depthAfter !== depthBefore) recomputeFeed(feedId);
    logActivity(
      actor,
      "feed.delivery",
      "feed",
      feedId,
      `Changed ${joinWords(changed.map((key) => DELIVERY_LABELS[key]))} of the feed ${q(feed.name)}.`,
    );
  });
}

export async function archiveFeed(feedId: number, actor: Actor): Promise<void> {
  requireName(actor);
  inImmediate(() => {
    const feed = requireFeed(feedId);
    if (feed.archivedAt !== null) return;
    getDb().update(feeds).set({ archivedAt: nowMs(), updatedAt: nowMs() }).where(eq(feeds.id, feedId)).run();
    logActivity(actor, "feed.archive", "feed", feedId, `Archived the feed ${q(feed.name)}.`);
  });
}

export async function restoreFeed(feedId: number, actor: Actor): Promise<void> {
  requireName(actor);
  inImmediate(() => {
    const feed = requireFeed(feedId);
    if (feed.archivedAt === null) return;
    getDb().update(feeds).set({ archivedAt: null, updatedAt: nowMs() }).where(eq(feeds.id, feedId)).run();
    logActivity(actor, "feed.restore", "feed", feedId, `Restored the feed ${q(feed.name)}.`);
  });
}

/** Only an archived feed can be deleted (§4.9). Its rows go by cascade. */
export async function deleteFeed(feedId: number, actor: Actor): Promise<void> {
  requireName(actor);
  inImmediate(() => {
    const feed = requireFeed(feedId);
    if (feed.archivedAt === null) {
      throw new ServiceError("conflict", "Archive the feed before you delete it.");
    }
    getDb().delete(feeds).where(eq(feeds.id, feedId)).run();
    logActivity(actor, "feed.delete", "feed", feedId, `Deleted the feed ${q(feed.name)} for ever.`);
  });
}

const feedSourceSchema = z.object({
  included: z.boolean(),
  priority: prioritySchema.optional(),
  follow: oneLineSchema.optional(),
  ignore: oneLineSchema.optional(),
});

/**
 * Include: insert or update the feed_sources row. A new link also starts
 * the backfill of §7.7 in the same transaction (queuedStories). A change of
 * Follow / Ignore on an existing link is judge-time: the page offers the
 * re-judge (§4.6), so no model work starts here.
 * Exclude: delete the row.
 * Then the rank-time recompute of the feed (source priority, a source that
 * enters or leaves, §8.4).
 */
export async function setFeedSource(
  feedId: number,
  sourceId: number,
  input: { included: boolean; priority?: Priority; follow?: string; ignore?: string },
  actor: Actor,
): Promise<{ queuedStories: number }> {
  requireName(actor);
  const data = parseOrThrow(feedSourceSchema, input);
  return inImmediate(() => {
    const feed = requireFeed(feedId);
    const source = Number.isInteger(sourceId)
      ? getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
      : undefined;
    if (!source) throw notFound("The source");
    const where = and(eq(feedSources.feedId, feedId), eq(feedSources.sourceId, sourceId));
    const existing = getDb().select().from(feedSources).where(where).get();
    let queuedStories = 0;

    if (!data.included) {
      if (!existing) return { queuedStories };
      getDb().delete(feedSources).where(where).run();
      recomputeFeed(feedId);
      logActivity(actor, "feed.source.exclude", "feed", feedId, `Removed the source ${q(source.name)} from the feed ${q(feed.name)}.`);
      return { queuedStories };
    }

    const fields = {
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.follow !== undefined ? { follow: data.follow } : {}),
      ...(data.ignore !== undefined ? { ignore: data.ignore } : {}),
    };
    if (existing) {
      if (Object.keys(fields).length > 0) getDb().update(feedSources).set(fields).where(where).run();
      if (data.priority !== undefined && data.priority !== existing.priority) recomputeFeed(feedId);
      logActivity(actor, "feed.source.update", "feed", feedId, `Changed how the feed ${q(feed.name)} uses the source ${q(source.name)}.`);
      return { queuedStories };
    }

    const now = nowMs();
    getDb()
      .insert(feedSources)
      .values({ feedId, sourceId, priority: "normal", follow: "", ignore: "", ...fields, addedBy: actor.name.trim(), createdAt: now })
      .run();
    const backfill = backfillFeedSource({ feedId, sourceId, requestedBy: actor.name.trim(), now });
    // Re-queued no_feed items have no story yet; each one becomes at most one story judged for this feed.
    queuedStories = backfill.queuedStories + backfill.queuedItems;
    recomputeFeed(feedId);
    logActivity(actor, "feed.source.include", "feed", feedId, `Added the source ${q(source.name)} to the feed ${q(feed.name)}.`);
    return { queuedStories };
  });
}
