// The zod schemas of the Server Actions of the feed pages (specification §14:
// every action validates its input and caps text lengths). A "use server"
// file may export only async functions, so the schemas live here.
import { z } from "zod";

import { LIMITS } from "@/lib/types";
import { feedbackReasonSchema, nameSchema, oneLineSchema } from "@/lib/form-schemas";

/** A feed slug as the services make it (slugify: lower-case letters of any script, digits, and dashes). */
export const feedSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]*$/u, "This feed address is not valid.");

export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Where a vote comes from: the main list, the filtered list, or the story page. */
export const voteOriginSchema = z.enum(["list", "filtered", "story"]);

export const voteInputSchema = z.object({
  feedSlug: feedSlugSchema,
  storyId: idSchema,
  /** null removes the vote. */
  reason: feedbackReasonSchema.nullable(),
  from: voteOriginSchema,
});
export type VoteInput = z.input<typeof voteInputSchema>;

export const analysisInputSchema = z.object({
  feedSlug: feedSlugSchema,
  storyId: idSchema,
});
export type AnalysisInput = z.input<typeof analysisInputSchema>;

export const flagSourceInputSchema = z.object({
  feedSlug: feedSlugSchema,
  storyId: idSchema,
  sourceId: idSchema,
  /** Optional note (one line). */
  note: oneLineSchema.default(""),
});
export type FlagSourceInput = z.input<typeof flagSourceInputSchema>;

export const addSuggestionInputSchema = z.object({
  feedSlug: feedSlugSchema,
  /** The name of the starter suggestion; the server looks up its config. */
  name: nameSchema,
});
export type AddSuggestionInput = z.input<typeof addSuggestionInputSchema>;

export const createFeedInputSchema = z.object({
  name: z
    .string({ error: "Enter a name for the feed." })
    .trim()
    .min(1, "Enter a name for the feed.")
    .max(LIMITS.name, `Use at most ${LIMITS.name} characters.`),
  purpose: z
    .string()
    .trim()
    .max(LIMITS.oneLine, `Use at most ${LIMITS.oneLine} characters.`)
    .default(""),
});
export type CreateFeedInput = z.input<typeof createFeedInputSchema>;
