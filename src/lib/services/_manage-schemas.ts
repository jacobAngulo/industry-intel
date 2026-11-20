// Zod schemas that several manage services share (the caps of §14).
import { z } from "zod";

import { LIMITS } from "@/lib/types";

/** Minutes between two checks of a source: 5 minutes to one week. */
export const checkIntervalSchema = z.number().int().min(5).max(7 * 24 * 60);

export const idSchema = z.number().int().positive();

/** An owner name: empty text means "no owner". */
export const ownerSchema = z
  .string()
  .trim()
  .max(LIMITS.name)
  .nullable()
  .transform((value) => (value === "" ? null : value));
