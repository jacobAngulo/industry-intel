// Small database helpers of the manage services (feeds, sources, settings).
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { getDb, getSqlite } from "@/lib/db/client";
import { feeds, settings, type FeedDbRow } from "@/lib/db/schema";
import { slugify } from "@/lib/text/words";
import { DAY_MS, nowMs } from "@/lib/time";
import type { SettingsKey } from "@/lib/types";

import { notFound, ServiceError } from "./_manage-errors";

/** §8.4: a rank-time setting recomputes the judgements of the feed from the last 30 days. */
export const RANK_TIME_RECOMPUTE_MS = 30 * DAY_MS;

/**
 * Runs `fn` in one IMMEDIATE transaction (a savepoint inside a transaction of
 * the caller). Read-then-write must use it (§16, trap 1 of §19).
 */
export function inImmediate<T>(fn: () => T): T {
  return getSqlite().transaction(fn).immediate();
}

/** Reads one settings value and validates it; the fallback when it is absent or not valid. */
export function readSetting<T>(key: SettingsKey, schema: z.ZodType<T>, fallback: () => T): T {
  const row = getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  if (!row) return fallback();
  const parsed = schema.safeParse(row.value);
  return parsed.success ? parsed.data : fallback();
}

/** Writes (or replaces) one settings value. */
export function writeSetting(key: SettingsKey, value: unknown, updatedBy: string, now: number = nowMs()): void {
  getDb()
    .insert(settings)
    .values({ key, value, updatedAt: now, updatedBy })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now, updatedBy } })
    .run();
}

/** The feed row, or a `not_found` ServiceError. */
export function requireFeed(feedId: number): FeedDbRow {
  const row = Number.isInteger(feedId) ? getDb().select().from(feeds).where(eq(feeds.id, feedId)).get() : undefined;
  if (!row) throw notFound("The feed");
  return row;
}

/**
 * A slug from the name that no row of `table` uses: "name", then "name-2",
 * "name-3", … (`table` is a fixed table name of this module, never input).
 */
export function uniqueSlug(table: "feeds" | "topics", name: string): string {
  const base = slugify(name);
  const taken = new Set(
    (
      getSqlite()
        .prepare(`SELECT slug FROM ${table} WHERE slug = ? OR slug LIKE ? ESCAPE '\\'`)
        .all(base, `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`) as Array<{ slug: string }>
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const slug = `${base}-${n}`;
    if (!taken.has(slug)) return slug;
  }
}

/** The number of rows of a table (for the caps of §14). */
export function countRows(table: "feeds" | "sources"): number {
  const row = getDb().get<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
  return row?.n ?? 0;
}

export function limitError(message: string): ServiceError {
  return new ServiceError("limit", message);
}

/** "19 Nov 2026, 14:05 UTC": the server does not know the time zone of the reader. */
export function formatUtc(ms: number): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms))} UTC`;
}

/** Quotes a name for an activity summary. */
export function q(name: string): string {
  return `"${name}"`;
}
