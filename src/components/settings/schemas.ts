// Zod schemas of the settings Server Actions (specification §4.8, §4.9, §14).
// Pure module: no database, no Next.js. The actions validate their input
// with these schemas; the services validate it again.
import { z } from "zod";

import { DIGEST_FREQUENCIES, LIMITS, PRIORITIES, RELEVANCE_WEIGHTS, SUMMARY_LENGTHS, TECHNICAL_DEPTHS, TOPIC_PRIORITIES } from "@/lib/types";
import { clockTimeSchema, timeZoneSchema } from "@/lib/form-schemas";

const ID_MESSAGE = "This item does not exist.";

export const idSchema = z.number({ error: ID_MESSAGE }).int(ID_MESSAGE).positive(ID_MESSAGE);

/** A whole number in [min, max] with one plain message. */
export function wholeNumberSchema(min: number, max: number) {
  const message = `Enter a whole number from ${min} to ${max}.`;
  return z.number({ error: message }).int(message).min(min, message).max(max, message);
}

/** Text with a cap and a plain message. `required` adds "Enter …". */
function text(max: number, opts: { required?: string } = {}) {
  const base = z.string({ error: "Enter text." }).trim().max(max, `Use at most ${max} characters.`);
  return opts.required ? base.min(1, opts.required) : base;
}

export const nameText = text(LIMITS.name, { required: "Enter a name." });
export const oneLineText = text(LIMITS.oneLine);
export const multiLineText = text(LIMITS.multiLine);

/** Exclusion phrases: no empty phrase, no duplicate (no case difference), at most 50. */
export const phraseListSchema = z
  .array(text(LIMITS.oneLine, { required: "A phrase cannot be empty." }))
  .max(LIMITS.listEntries, `Use at most ${LIMITS.listEntries} phrases.`)
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((phrase) => {
      const key = phrase.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const relevancePrioritiesInput = z.object({
  practical: z.enum(RELEVANCE_WEIGHTS),
  experiment: z.enum(RELEVANCE_WEIGHTS),
  other: multiLineText,
});

export const minRelevanceInput = wholeNumberSchema(0, 100);
export const halfLifeInput = wholeNumberSchema(1, 720);

export const digestInput = z.object({
  frequency: z.enum(DIGEST_FREQUENCIES),
  weekday: wholeNumberSchema(0, 6),
  time: clockTimeSchema,
  timeZone: timeZoneSchema,
  maxStories: wholeNumberSchema(1, 50),
});

export const quietHoursInput = z.object({ enabled: z.boolean(), start: clockTimeSchema, end: clockTimeSchema });

export const alertsInput = z.object({ enabled: z.boolean(), rule: oneLineText, minRelevance: wholeNumberSchema(0, 100) });

export const briefFormatInput = z.object({
  summaryLength: z.enum(SUMMARY_LENGTHS),
  technicalDepth: z.enum(TECHNICAL_DEPTHS),
  suggestedActions: z.boolean(),
});

export const briefOverrideInput = z.object({
  summaryLength: z.enum(SUMMARY_LENGTHS).nullable(),
  technicalDepth: z.enum(TECHNICAL_DEPTHS).nullable(),
  suggestedActions: z.boolean().nullable(),
});

export const teamProfileInput = z.object({
  whatWeDo: multiLineText,
  constraints: multiLineText,
});

// ---------------------------------------------------------------------------
// Feed settings (§4.8)
// ---------------------------------------------------------------------------

export const feedSourceInput = z.object({
  feedId: idSchema,
  sourceId: idSchema,
  included: z.boolean(),
  priority: z.enum(PRIORITIES).optional(),
  follow: oneLineText.optional(),
  ignore: oneLineText.optional(),
});

export const feedProfileInput = z.object({
  feedId: idSchema,
  name: nameText,
  purpose: oneLineText,
  projectContext: multiLineText,
});

const NOTHING_TO_SAVE = "Nothing to save.";

/** True when the patch has at least one key besides feedId. */
function hasPatchKey(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([key, v]) => key !== "feedId" && v !== undefined);
}

/**
 * A FeedInterestsPatch (one section of the Interests group). Only the keys
 * of the saved section are present; `topicPriorities` holds only the topics
 * whose priority changed. The service merges the patch into the stored values.
 */
export const feedInterestsInput = z
  .object({
    feedId: idSchema,
    topicPriorities: z
      .record(z.string().regex(/^\d+$/, ID_MESSAGE), z.enum(TOPIC_PRIORITIES))
      .refine((value) => Object.keys(value).length <= 500, "Too many topics.")
      .optional(),
    exclusions: phraseListSchema.optional(),
    relevancePriorities: relevancePrioritiesInput.optional(),
    minRelevance: minRelevanceInput.optional(),
    halfLifeHours: halfLifeInput.optional(),
  })
  .refine(hasPatchKey, NOTHING_TO_SAVE);

/** A FeedDeliveryPatch (one section of the Delivery group), merged in the same way. */
export const feedDeliveryInput = z
  .object({
    feedId: idSchema,
    briefFormat: briefOverrideInput.optional(),
    digest: digestInput.optional(),
    quietHours: quietHoursInput.optional(),
    alerts: alertsInput.optional(),
  })
  .refine(hasPatchKey, NOTHING_TO_SAVE);

export const feedIdInput = z.object({ feedId: idSchema });

export const rejudgeInput = z.object({
  feedIds: z.array(idSchema).min(1, "Choose a feed.").max(LIMITS.maxFeeds),
  sourceId: idSchema.optional(),
});

// ---------------------------------------------------------------------------
// Shared settings (§4.9)
// ---------------------------------------------------------------------------

export const topicInput = z.object({ name: nameText, description: oneLineText });
export const topicUpdateInput = topicInput.extend({ id: idSchema });
export const topicIdInput = z.object({ id: idSchema });

export const defaultsInput = z.object({
  briefDefaults: briefFormatInput,
  defaultExclusions: phraseListSchema,
  feedDefaults: z.object({
    minRelevance: minRelevanceInput,
    halfLifeHours: halfLifeInput,
    digest: digestInput,
    quietHours: quietHoursInput,
    alerts: alertsInput,
  }),
});
