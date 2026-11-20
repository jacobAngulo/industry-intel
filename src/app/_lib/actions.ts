"use server";

// Shared Server Actions (specification §15). The helpers for other actions are
// in ./action-helpers.ts (a "use server" file may export only async functions).
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";

import type { ActionResult } from "@/lib/services/types";

import { fail, ok, zodFieldErrors } from "./action-helpers";
import { ANONYMOUS_NAME, COOKIE_MAX_AGE_SECONDS, NAME_COOKIE, NAME_MAX_LENGTH, cleanDisplayName } from "./identity-constants";

const nameSchema = z
  .string({ error: "Enter your name." })
  .max(500, { error: `Use at most ${NAME_MAX_LENGTH} characters.` })
  .transform((value, ctx) => {
    const cleaned = cleanDisplayName(value);
    if (cleaned === null) {
      ctx.addIssue({
        code: "custom",
        message: value.trim().length === 0 ? "Enter your name." : `Use 1 to ${NAME_MAX_LENGTH} characters.`,
      });
      return z.NEVER;
    }
    // Every service refuses the anonymous actor name (needs_name), so it cannot be a display name.
    if (cleaned.toLowerCase() === ANONYMOUS_NAME.toLowerCase()) {
      ctx.addIssue({ code: "custom", message: `Use your own name, not '${ANONYMOUS_NAME}'.` });
      return z.NEVER;
    }
    return cleaned;
  });

/**
 * Stores the display name in the cookie `ii_name` (httpOnly, SameSite=Lax, 1 year).
 * Takes the name, or FormData with the field `name`.
 */
export async function setName(input: string | FormData): Promise<ActionResult<{ name: string }>> {
  const raw = typeof input === "string" ? input : input.get("name");
  const parsed = nameSchema.safeParse(typeof raw === "string" ? raw : "");
  if (!parsed.success) {
    const fieldErrors = zodFieldErrors(parsed.error);
    const message = Object.values(fieldErrors)[0] ?? "Enter your name.";
    return fail(message, "validation", { name: message });
  }
  const name = parsed.data;
  const cookieStore = await cookies();
  cookieStore.set({
    name: NAME_COOKIE,
    value: name,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    // No `secure` flag: the app can run on plain http inside the company network.
  });
  // The name shows in the navigation of every page.
  revalidatePath("/", "layout");
  return ok({ name }, "Saved");
}
