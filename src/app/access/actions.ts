"use server";

import { revalidatePath } from "next/cache";

import { fail, ok } from "@/app/_lib/action-helpers";
import { getSessionAccount } from "@/app/_lib/identity";
import { serviceFailure, submitAccessRequest, type ActionResult } from "@/lib/services";

/** Asks for access. The one change that needs a session but no access. */
export async function submitAccessRequestAction(
  _previous: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const account = await getSessionAccount();
  if (!account) return fail("Your session has ended. Reload the page and sign in again.", "unauthenticated");
  const note = formData.get("note");
  try {
    submitAccessRequest(account.id, typeof note === "string" ? note : "");
  } catch (error) {
    return serviceFailure(error);
  }
  revalidatePath("/access");
  return ok(null);
}
