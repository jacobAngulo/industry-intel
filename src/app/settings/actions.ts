"use server";

// Server Actions of the shared settings (specification §4.9) and the re-judge
// request that every settings page offers (§4.8, §7.6). Each action checks the
// display name, validates its input with zod, calls one service, and
// revalidates the pages. The feed settings import the shared ones from here.
import { revalidatePath } from "next/cache";

import { ok, parseInput, withActor } from "@/app/_lib/action-helpers";
import { rejudgeEstimates } from "@/components/settings/estimates";
import type { RejudgeEstimate } from "@/components/settings/helpers";
import {
  defaultsInput,
  feedIdInput,
  idSchema,
  rejudgeInput,
  teamProfileInput,
  topicIdInput,
  topicInput,
  topicUpdateInput,
} from "@/components/settings/schemas";
import {
  archiveTopic,
  createTopic,
  deleteFeed,
  requestRejudge,
  restoreFeed,
  serviceFailure,
  updateDefaults,
  updateTeamProfile,
  updateTopic,
  type ActionResult,
  type TopicRow,
} from "@/lib/services";

/** Every page can show a changed setting (feed tabs, banners, feed pages). */
function revalidateAll(): void {
  revalidatePath("/", "layout");
}

/** Saves the shared feed profile. Returns the re-judge estimate of each active feed. */
export async function saveTeamProfileAction(input: unknown): Promise<ActionResult<RejudgeEstimate[]>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(teamProfileInput, input);
    if (!parsed.ok) return parsed;
    try {
      await updateTeamProfile(parsed.data, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(await rejudgeEstimates());
  });
}

/** Asks for a re-judge of the last 7 days for each given feed (optionally one source only). */
export async function requestRejudgeAction(input: unknown): Promise<ActionResult<{ requested: number }>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(rejudgeInput, input);
    if (!parsed.ok) return parsed;
    const { feedIds, sourceId } = parsed.data;
    let requested = 0;
    try {
      for (const feedId of feedIds) {
        await requestRejudge(feedId, sourceId === undefined ? {} : { sourceId }, actor);
        requested += 1;
      }
    } catch (error) {
      if (requested > 0) revalidateAll();
      return serviceFailure(error);
    }
    revalidateAll();
    return ok({ requested });
  });
}

const addTopicInput = topicInput.extend({ feedId: idSchema.optional() });

/**
 * Adds a shared topic. A new topic is judge-time (§8.4): the result carries
 * the re-judge estimate of the given feed, or of every active feed.
 */
export async function addTopicAction(
  input: unknown,
): Promise<ActionResult<{ topic: TopicRow; estimates: RejudgeEstimate[] }>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(addTopicInput, input);
    if (!parsed.ok) return parsed;
    let topic: TopicRow;
    try {
      topic = await createTopic({ name: parsed.data.name, description: parsed.data.description }, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    const feedId = parsed.data.feedId;
    return ok({ topic, estimates: await rejudgeEstimates(feedId === undefined ? {} : { feedIds: [feedId] }) });
  });
}

export async function updateTopicAction(input: unknown): Promise<ActionResult<null>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(topicUpdateInput, input);
    if (!parsed.ok) return parsed;
    try {
      await updateTopic(parsed.data.id, { name: parsed.data.name, description: parsed.data.description }, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(null);
  });
}

export async function archiveTopicAction(input: unknown): Promise<ActionResult<null>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(topicIdInput, input);
    if (!parsed.ok) return parsed;
    try {
      await archiveTopic(parsed.data.id, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(null);
  });
}

export async function saveDefaultsAction(input: unknown): Promise<ActionResult<null>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(defaultsInput, input);
    if (!parsed.ok) return parsed;
    try {
      await updateDefaults(parsed.data, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(null);
  });
}

export async function restoreFeedAction(input: unknown): Promise<ActionResult<null>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedIdInput, input);
    if (!parsed.ok) return parsed;
    try {
      await restoreFeed(parsed.data.feedId, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(null, "The feed is back in the tabs.");
  });
}

/** Deletes an archived feed for ever (its judgements, digests, and alerts go too). */
export async function deleteFeedAction(input: unknown): Promise<ActionResult<null>> {
  return withActor({ needsName: true }, async (actor) => {
    const parsed = parseInput(feedIdInput, input);
    if (!parsed.ok) return parsed;
    try {
      await deleteFeed(parsed.data.feedId, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidateAll();
    return ok(null, "The feed is deleted.");
  });
}
