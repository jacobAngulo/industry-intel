"use server";

// Server Actions of the source directory and the source page (specification
// §4.5, §4.6, §18). Each one: zod, the actor, the service,
// revalidatePath, an ActionResult.
import { revalidatePath } from "next/cache";

import { fail, ok, parseInput, withActor } from "@/app/_lib/action-helpers";
import {
  deleteSource,
  estimateRejudge,
  flagNoisy,
  getSource,
  requestCheck,
  requestRejudge,
  resolveFlags,
  serviceFailure,
  setFeedSource,
  setPaused,
  updateSource,
  type ActionResult,
  type RejudgeProgress,
} from "@/lib/services";

import {
  aboutInput,
  configInput,
  feedLinkInput,
  flagInput,
  pausedInput,
  rejudgeInput,
  sourceIdInput,
  type FeedLinkResult,
} from "./schemas";

function refreshSource(id: number): void {
  revalidatePath(`/sources/${id}`);
  revalidatePath("/sources");
}

export async function checkNowAction(input: { id: number }): Promise<ActionResult> {
  const parsed = parseInput(sourceIdInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    try {
      await requestCheck(parsed.data.id, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    refreshSource(parsed.data.id);
    return ok(undefined, "A check is requested. The worker runs it within a few seconds.");
  });
}

export async function setPausedAction(input: { id: number; paused: boolean }): Promise<ActionResult> {
  const parsed = parseInput(pausedInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    try {
      await setPaused(parsed.data.id, parsed.data.paused, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    refreshSource(parsed.data.id);
    return ok(undefined, parsed.data.paused ? "The source is paused." : "The source is active again.");
  });
}

export async function deleteSourceAction(input: { id: number }): Promise<ActionResult<{ name: string }>> {
  const parsed = parseInput(sourceIdInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    const source = await getSource(parsed.data.id);
    if (!source) return fail("The source does not exist. Somebody deleted it already.", "not_found");
    try {
      await deleteSource(parsed.data.id, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidatePath("/sources");
    revalidatePath("/", "layout");
    return ok({ name: source.name }, `Deleted the source "${source.name}".`);
  });
}

/** Saves only the about fields that the person changed (the others keep their stored values). */
export async function updateAboutAction(input: {
  id: number;
  name?: string;
  why?: string;
  owner?: string | null;
  checkIntervalMinutes?: number;
}): Promise<ActionResult> {
  const parsed = parseInput(aboutInput, input);
  if (!parsed.ok) return parsed;
  const { id, ...fields } = parsed.data;
  return withActor(async (actor) => {
    try {
      await updateSource(id, fields, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    refreshSource(id);
    return ok(undefined, "Saved");
  });
}

export async function updateConfigAction(input: { id: number; config: Record<string, unknown> }): Promise<ActionResult> {
  const parsed = parseInput(configInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    try {
      await updateSource(parsed.data.id, { config: parsed.data.config }, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    refreshSource(parsed.data.id);
    return ok(undefined, "Saved");
  });
}


export async function setFeedLinkAction(input: {
  sourceId: number;
  feedId: number;
  included: boolean;
  priority: "high" | "normal" | "low";
  follow: string;
  ignore: string;
}): Promise<ActionResult<FeedLinkResult>> {
  const parsed = parseInput(feedLinkInput, input);
  if (!parsed.ok) return parsed;
  const { sourceId, feedId, included, priority, follow, ignore } = parsed.data;
  return withActor(async (actor) => {
    const before = await getSource(sourceId);
    if (!before) return fail("The source does not exist.", "not_found");
    const link = before.feedLinks.find((l) => l.feedId === feedId);
    if (!link) return fail("The feed does not exist or is archived.", "not_found");
    let queuedStories = 0;
    try {
      const result = await setFeedSource(
        feedId,
        sourceId,
        included ? { included, priority, follow, ignore } : { included: false },
        actor,
      );
      queuedStories = result.queuedStories;
    } catch (error) {
      return serviceFailure(error);
    }
    const filtersChanged = included && link.included && (link.follow !== follow || link.ignore !== ignore);
    const rejudgeEstimate = filtersChanged ? await estimateRejudge(feedId, { sourceId }) : null;
    refreshSource(sourceId);
    revalidatePath(`/f/${link.slug}`, "layout");
    return ok({ included, wasIncluded: link.included, queuedStories, rejudgeEstimate }, "Saved");
  });
}

export async function rejudgeSourceAction(input: { sourceId: number; feedId: number }): Promise<ActionResult<RejudgeProgress>> {
  const parsed = parseInput(rejudgeInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    try {
      const progress = await requestRejudge(parsed.data.feedId, { sourceId: parsed.data.sourceId }, actor);
      refreshSource(parsed.data.sourceId);
      return ok(progress, "The re-judge is queued.");
    } catch (error) {
      return serviceFailure(error);
    }
  });
}

export async function flagNoisyAction(input: { id: number; note: string }): Promise<ActionResult> {
  const parsed = parseInput(flagInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    try {
      await flagNoisy(parsed.data.id, parsed.data.note, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    refreshSource(parsed.data.id);
    return ok(undefined, "The source is flagged as noisy.");
  });
}

export async function resolveFlagsAction(input: { id: number }): Promise<ActionResult> {
  const parsed = parseInput(sourceIdInput, input);
  if (!parsed.ok) return parsed;
  return withActor(async (actor) => {
    try {
      await resolveFlags(parsed.data.id, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    refreshSource(parsed.data.id);
    return ok(undefined, "The flags are resolved.");
  });
}
