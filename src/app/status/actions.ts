"use server";

// Server Actions of the status page (specification §4.10).
import { revalidatePath } from "next/cache";

import { ok, withActor } from "@/app/_lib/action-helpers";
import { requestCheckAllDue, retryFailedItems, serviceFailure, type ActionResult } from "@/lib/services";

/** Asks the worker to check every source that is not paused, now. */
export async function checkAllDueAction(): Promise<ActionResult<{ count: number }>> {
  return withActor({ needsName: true }, async (actor) => {
    let count: number;
    try {
      count = await requestCheckAllDue(actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidatePath("/", "layout");
    return ok({ count });
  });
}

/** Puts the failed items back in the queue for the model (attempts 0). */
export async function retryFailedAction(): Promise<ActionResult<{ count: number }>> {
  return withActor({ needsName: true }, async (actor) => {
    let count: number;
    try {
      count = await retryFailedItems(actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidatePath("/", "layout");
    return ok({ count });
  });
}
