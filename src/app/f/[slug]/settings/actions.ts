"use server";

// Server Actions of the feed settings (specification §4.8). Each action checks
// the display name, validates its input with zod, calls one service, and
// revalidates the pages. The actions that save a judge-time setting (§8.4)
// return the re-judge estimate, so that the page can offer the re-judge.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ok, parseInput, withActor } from "@/app/_lib/action-helpers";
import { rejudgeEstimates } from "@/components/settings/estimates";
import type { RejudgeEstimate } from "@/components/settings/helpers";
import {
  feedDeliveryInput,
  feedIdInput,
  feedInterestsInput,
  feedProfileInput,
  feedSourceInput,
} from "@/components/settings/schemas";
import {
  archiveFeed,
  serviceFailure,
  setFeedSource,
  updateFeedDelivery,
  updateFeedInterests,
  updateFeedProfile,
  type ActionResult,
} from "@/lib/services";
import type { FeedDeliveryPatch, FeedInterestsPatch } from "@/lib/services/types";

function revalidateAll(): void {
  revalidatePath("/", "layout");
}

/**
 * Includes, updates, or excludes one source in the feed. The result has the
 * count of the stories that the include queued (§7.7), and for an included
 * source the re-judge estimate of this source (after a change of Follow / Ignore).
 */
export async function setFeedSourceAction(
  input: unknown,
): Promise<ActionResult<{ queuedStories: number; estimates: RejudgeEstimate[] }>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedSourceInput, input);
    if (!parsed.ok) return parsed;
    const { feedId, sourceId, ...link } = parsed.data;
    let queuedStories: number;
    try {
      ({ queuedStories } = await setFeedSource(feedId, sourceId, link, actor));
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    const estimates = link.included ? await rejudgeEstimates({ feedIds: [feedId], sourceId }) : [];
    return ok({ queuedStories, estimates });
  });
}

export async function saveFeedProfileAction(input: unknown): Promise<ActionResult<RejudgeEstimate[]>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedProfileInput, input);
    if (!parsed.ok) return parsed;
    const { feedId, ...profile } = parsed.data;
    try {
      await updateFeedProfile(feedId, profile, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(await rejudgeEstimates({ feedIds: [feedId] }));
  });
}

/**
 * Takes a FeedInterestsPatch: only the keys of the saved section (§18.2). The
 * service merges it into the stored values, so a save never reverts a change
 * that another person saved in another section.
 */
export async function saveFeedInterestsAction(input: unknown): Promise<ActionResult<RejudgeEstimate[]>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedInterestsInput, input);
    if (!parsed.ok) return parsed;
    const { feedId, ...rest } = parsed.data;
    const interests: FeedInterestsPatch = rest;
    try {
      await updateFeedInterests(feedId, interests, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(await rejudgeEstimates({ feedIds: [feedId] }));
  });
}

/** Takes a FeedDeliveryPatch: only the keys of the saved section, merged in the same way. */
export async function saveFeedDeliveryAction(input: unknown): Promise<ActionResult<RejudgeEstimate[]>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedDeliveryInput, input);
    if (!parsed.ok) return parsed;
    const { feedId, ...rest } = parsed.data;
    const delivery: FeedDeliveryPatch = rest;
    try {
      await updateFeedDelivery(feedId, delivery, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(await rejudgeEstimates({ feedIds: [feedId] }));
  });
}

/** Archives the feed, then opens the shared settings (where it can be restored). */
export async function archiveFeedAction(input: unknown): Promise<ActionResult<null>> {
  const result = await withActor<null>({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedIdInput, input);
    if (!parsed.ok) return parsed;
    try {
      await archiveFeed(parsed.data.feedId, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    return ok(null);
  });
  if (!result.ok) return result;
  revalidateAll();
  // redirect() throws: it stays outside every try / catch.
  redirect("/settings#archived-feeds");
}
