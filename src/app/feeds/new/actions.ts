"use server";

// The Server Action of /feeds/new (specification §3, §4.9, §18): creates a
// feed from the shared feed_defaults and opens its source settings.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { parseForm, withActor } from "@/app/_lib/action-helpers";
import { createFeedInputSchema } from "@/components/feed/schemas";
import { createFeed, serviceFailure, type ActionResult } from "@/lib/services";

/** The state of the form: the failure and the typed values (React resets the form after an action). */
export interface NewFeedState {
  result: ActionResult<null>;
  values: { name: string; purpose: string };
}

function text(formData: FormData, key: string, max: number): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** For useActionState. Redirects to the source settings of the new feed on success. */
export async function createFeedAction(_previous: NewFeedState | null, formData: FormData): Promise<NewFeedState> {
  const values = { name: text(formData, "name", 500), purpose: text(formData, "purpose", 1000) };
  const parsed = parseForm(createFeedInputSchema, formData);
  if (!parsed.ok) return { result: parsed, values };
  const result = await withActor<{ slug: string }>(async (actor) => {
    try {
      const feed = await createFeed(parsed.data, actor);
      return { ok: true, data: { slug: feed.slug } };
    } catch (error) {
      return serviceFailure(error);
    }
  });
  if (!result.ok) return { result, values };
  // The new feed tab shows in the navigation of every page.
  revalidatePath("/", "layout");
  redirect(`/f/${encodeURIComponent(result.data.slug)}/settings/sources`);
}
