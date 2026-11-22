"use server";

// The Server Action of the feedback panel. It writes nothing in this app: it
// relays the submission to the Ticket Board backlog of the project.
import type { ActionResult } from "@/lib/services/types";

import { fail, ok, withActor, zodFieldErrors } from "./action-helpers";
import { feedbackSchema, relayFeedback } from "./feedback";
import { getUser } from "./identity";

export async function submitFeedback(input: unknown): Promise<ActionResult<{ identifier: string }>> {
  return withActor(async (actor) => {
    const parsed = feedbackSchema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors = zodFieldErrors(parsed.error);
      return fail(Object.values(fieldErrors)[0] ?? "Check the form.", "validation", fieldErrors);
    }
    const result = await relayFeedback(parsed.data, { ...actor, email: (await getUser())?.email ?? null });
    if (result.ok) return ok({ identifier: result.identifier }, `${result.identifier} was added to the backlog.`);
    if (result.reason === "not_configured") return fail("Feedback is not set up on this server.");
    if (result.reason === "unavailable") return fail("The ticket board did not answer. Try again in a minute.");
    return fail(result.detail ? `The ticket board refused the request: ${result.detail}` : "The ticket board refused the request.");
  });
}
