// The zod schemas of the shared shapes that people edit in forms (shared feed profile,
// brief format, digest, quiet hours, alerts, relevance priorities, feed
// defaults) and the small schemas that the services and the Server Actions
// share. They live apart from src/lib/types.ts so that a client component that
// needs only a label or a type from types.ts does not pull zod into its bundle.
import { z } from "zod";

import {
  DIGEST_FREQUENCIES,
  FEEDBACK_REASONS,
  LIMITS,
  PRIORITIES,
  RELEVANCE_WEIGHTS,
  SOURCE_TYPES,
  SUMMARY_LENGTHS,
  TECHNICAL_DEPTHS,
  TOPIC_PRIORITIES,
  type AlertSettings,
  type BriefFormat,
  type BriefFormatOverride,
  type DigestSettings,
  type FeedDefaults,
  type QuietHours,
  type RelevancePriorities,
  type TeamProfile,
} from "./types";

const trimmed = (max: number) => z.string().trim().max(max);

export const nameSchema = z.string().trim().min(1).max(LIMITS.name);
export const oneLineSchema = trimmed(LIMITS.oneLine);
export const multiLineSchema = trimmed(LIMITS.multiLine);

export const prioritySchema = z.enum(PRIORITIES);
export const topicPrioritySchema = z.enum(TOPIC_PRIORITIES);
export const feedbackReasonSchema = z.enum(FEEDBACK_REASONS);
export const sourceTypeSchema = z.enum(SOURCE_TYPES);

export const teamProfileSchema = z.object({
  whatWeDo: multiLineSchema,
  constraints: multiLineSchema,
}) satisfies z.ZodType<TeamProfile>;

export const briefFormatSchema = z.object({
  summaryLength: z.enum(SUMMARY_LENGTHS),
  technicalDepth: z.enum(TECHNICAL_DEPTHS),
  suggestedActions: z.boolean(),
}) satisfies z.ZodType<BriefFormat>;

export const briefFormatOverrideSchema = z.object({
  summaryLength: z.enum(SUMMARY_LENGTHS).nullable(),
  technicalDepth: z.enum(TECHNICAL_DEPTHS).nullable(),
  suggestedActions: z.boolean().nullable(),
}) satisfies z.ZodType<BriefFormatOverride>;

/** "HH:MM" in 24 h form. */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use the form HH:MM (24 hours).");

/** True for a time zone name that this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Use an IANA time zone name, for example Europe/Berlin.");

export const digestSettingsSchema = z.object({
  frequency: z.enum(DIGEST_FREQUENCIES),
  weekday: z.number().int().min(0).max(6),
  time: clockTimeSchema,
  timeZone: timeZoneSchema,
  maxStories: z.number().int().min(1).max(50),
}) satisfies z.ZodType<DigestSettings>;

export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start: clockTimeSchema,
  end: clockTimeSchema,
}) satisfies z.ZodType<QuietHours>;

export const alertSettingsSchema = z.object({
  enabled: z.boolean(),
  rule: oneLineSchema,
  minRelevance: z.number().int().min(0).max(100),
}) satisfies z.ZodType<AlertSettings>;

export const relevancePrioritiesSchema = z.object({
  practical: z.enum(RELEVANCE_WEIGHTS),
  experiment: z.enum(RELEVANCE_WEIGHTS),
  other: multiLineSchema,
}) satisfies z.ZodType<RelevancePriorities>;

export const minRelevanceSchema = z.number().int().min(0).max(100);
/** Half-life in hours: 1 hour to 30 days. */
export const halfLifeHoursSchema = z.number().int().min(1).max(720);

export const feedDefaultsSchema = z.object({
  minRelevance: minRelevanceSchema,
  halfLifeHours: halfLifeHoursSchema,
  digest: digestSettingsSchema,
  quietHours: quietHoursSchema,
  alerts: alertSettingsSchema,
}) satisfies z.ZodType<FeedDefaults>;

/** A list of exclusion phrases: no empty entry, no duplicate (no case difference), at most 50. */
export const exclusionsSchema = z
  .array(z.string().trim().min(1).max(LIMITS.oneLine))
  .max(LIMITS.listEntries)
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((phrase) => {
      const key = phrase.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
