// The zod schemas of the Server Actions of the source pages (specification
// §4.6, §4.7, §14). A "use server" file may export only async functions, so
// the schemas live here (and the tests import them).
import { z } from "zod";

import { LIMITS } from "@/lib/types";
import { prioritySchema, sourceTypeSchema } from "@/lib/form-schemas";

import { MAX_ENTRIES, MAX_ENTRY_CHARS } from "@/components/sources/wizard-logic";

export const idSchema = z.number().int().positive();

/** Minutes between two checks: 5 minutes to one week (the service cap). */
export const intervalSchema = z
  .number({ error: "Choose a check interval." })
  .int()
  .min(5, "Use at least 5 minutes.")
  .max(7 * 24 * 60, "Use at most one week.");

/** An owner name; empty text means "no owner". */
export const ownerSchema = z
  .string()
  .trim()
  .max(LIMITS.name, `Use at most ${LIMITS.name} characters.`)
  .nullable()
  .transform((value) => (value ? value : null));

/** A source name (§14: names 120). */
export const nameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(LIMITS.name, `Use at most ${LIMITS.name} characters.`);

/** A one-line field (§14: 300). */
export const oneLineSchema = z.string().trim().max(LIMITS.oneLine, `Use at most ${LIMITS.oneLine} characters.`);

const whySchema = oneLineSchema.min(1, "Say why this source matters.");

// ---------------------------------------------------------------------------
// The source page
// ---------------------------------------------------------------------------

export const sourceIdInput = z.object({ id: idSchema });

export const pausedInput = z.object({ id: idSchema, paused: z.boolean() });

/** Only the about fields that changed (at least one): updateSource takes optional fields. */
export const aboutInput = z
  .object({
    id: idSchema,
    name: nameSchema.optional(),
    why: whySchema.optional(),
    owner: ownerSchema.optional(),
    checkIntervalMinutes: intervalSchema.optional(),
  })
  .refine(
    (value) => Object.entries(value).some(([key, v]) => key !== "id" && v !== undefined),
    "Nothing to save.",
  );

export const configInput = z.object({ id: idSchema, config: z.record(z.string(), z.unknown()) });

export const feedLinkInput = z.object({
  sourceId: idSchema,
  feedId: idSchema,
  included: z.boolean(),
  priority: prioritySchema,
  follow: oneLineSchema,
  ignore: oneLineSchema,
});

export interface FeedLinkResult {
  included: boolean;
  /** True when the source was in the feed before the save. */
  wasIncluded: boolean;
  /** §7.7: the stories that the include queued. */
  queuedStories: number;
  /** §7.6: the model calls of a re-judge, when Follow or Ignore changed; else null. */
  rejudgeEstimate: number | null;
}

export const rejudgeInput = z.object({ sourceId: idSchema, feedId: idSchema });

export const flagInput = z.object({ id: idSchema, note: oneLineSchema });

// ---------------------------------------------------------------------------
// The add-source flow
// ---------------------------------------------------------------------------

export const resolveInput = z.object({
  entries: z
    .array(z.string().trim().max(MAX_ENTRY_CHARS, `Use at most ${MAX_ENTRY_CHARS} characters for one entry.`))
    .transform((list) => list.filter(Boolean))
    .pipe(
      z
        .array(z.string())
        .min(1, "Paste a link, enter a sender, or describe a topic.")
        .max(MAX_ENTRIES, `Enter at most ${MAX_ENTRIES} entries at one time.`),
    ),
  type: sourceTypeSchema.nullable().optional(),
});

const wizardEntry = z.object({
  type: sourceTypeSchema,
  name: nameSchema,
  url: z.string().trim().max(MAX_ENTRY_CHARS).optional(),
  config: z.unknown(),
});

export const commonInput = z.object({
  why: whySchema,
  feedIds: z.array(idSchema).max(LIMITS.maxFeeds),
  follow: oneLineSchema,
  ignore: oneLineSchema,
  priority: prioritySchema,
  checkIntervalMinutes: intervalSchema,
  owner: ownerSchema,
});

const wizardEntries = z.array(wizardEntry).min(1, "Choose at least one source.").max(MAX_ENTRIES);

/** Step 2 to step 3: the entries and the common fields, then the preview. */
export const previewInput = z.object({ entries: wizardEntries, common: commonInput });

const previewItem = z.object({
  externalId: z.string().max(MAX_ENTRY_CHARS),
  title: z.string().max(MAX_ENTRY_CHARS),
  url: z.string().max(MAX_ENTRY_CHARS).nullable(),
  publishedAt: z.number().nullable(),
  excerpt: z.string().max(LIMITS.multiLine),
});

export const qualifyInput = z.object({
  type: sourceTypeSchema,
  sourceName: nameSchema,
  items: z.array(previewItem).max(100),
  config: z.unknown(),
  feedIds: z.array(idSchema).max(LIMITS.maxFeeds),
  follow: oneLineSchema,
  ignore: oneLineSchema,
  priority: prioritySchema,
});

export const createInput = z.object({ entries: wizardEntries, common: commonInput });
