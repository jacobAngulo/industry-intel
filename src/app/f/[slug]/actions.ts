"use server";

// The Server Actions of the feed pages (specification §4.1–§4.3, §18).
// Each action validates its input with zod, reads the actor, calls one
// service, maps a ServiceError to a failure result, and revalidates the pages
// that changed. The schemas are in src/components/feed/schemas.ts.
import { revalidatePath } from "next/cache";

import { fail, ok, parseInput, withActor } from "@/app/_lib/action-helpers";
import {
  addSuggestionInputSchema,
  analysisInputSchema,
  flagSourceInputSchema,
  voteInputSchema,
  type AddSuggestionInput,
  type AnalysisInput,
  type FlagSourceInput,
  type VoteInput,
} from "@/components/feed/schemas";
import {
  createFromWizard,
  flagNoisy,
  getFeedBySlug,
  listSuggestions,
  requestAnalysis,
  serviceFailure,
  vote,
  type ActionResult,
  type FeedDetail,
} from "@/lib/services";
import { SOURCE_TYPE_DEFAULTS, type FeedbackReason } from "@/lib/types";

const FEED_GONE = "This feed does not exist or is archived. Reload the page.";

async function activeFeed(slug: string): Promise<FeedDetail | null> {
  const feed = await getFeedBySlug(slug);
  return feed && !feed.archived ? feed : null;
}

function feedPath(slug: string): string {
  return `/f/${encodeURIComponent(slug)}`;
}

function storyPath(slug: string, storyId: number): string {
  return `${feedPath(slug)}/story/${storyId}`;
}

/**
 * Sets, changes, or removes the vote of this browser (no name needed).
 * From the story page the page is revalidated (the judgement can change).
 * From the feed lists nothing is revalidated: the buttons show the result,
 * and a card hidden by the vote keeps its line "Hidden for you. Undo" until
 * the next page load (§4.3). A revalidation would re-render the list
 * without the story at once.
 */
export async function voteAction(
  input: VoteInput,
): Promise<ActionResult<{ votes: Record<FeedbackReason, number>; myVote: FeedbackReason | null }>> {
  const parsed = parseInput(voteInputSchema, input);
  if (!parsed.ok) return parsed;
  const { feedSlug, storyId, reason, from } = parsed.data;
  return withActor({ needsName: false }, async (actor) => {
    const feed = await activeFeed(feedSlug);
    if (!feed) return fail(FEED_GONE, "not_found");
    try {
      const result = await vote(feed.id, storyId, reason, actor);
      if (from === "story") revalidatePath(storyPath(feed.slug, storyId));
      return ok(result);
    } catch (error) {
      return serviceFailure(error);
    }
  });
}

/** Queues the deeper analysis ("Write the deeper analysis", "Write again", "Try again"). Needs a name. */
export async function requestAnalysisAction(input: AnalysisInput): Promise<ActionResult<{ status: string }>> {
  const parsed = parseInput(analysisInputSchema, input);
  if (!parsed.ok) return parsed;
  const { feedSlug, storyId } = parsed.data;
  return withActor({ needsName: true }, async (actor) => {
    const feed = await activeFeed(feedSlug);
    if (!feed) return fail(FEED_GONE, "not_found");
    try {
      const view = await requestAnalysis(feed.id, storyId, actor);
      revalidatePath(storyPath(feed.slug, storyId));
      revalidatePath(feedPath(feed.slug));
      return ok({ status: view.status });
    } catch (error) {
      return serviceFailure(error);
    }
  });
}

/** "Flag source as noisy" with an optional note. Needs a name. */
export async function flagSourceAction(input: FlagSourceInput): Promise<ActionResult<null>> {
  const parsed = parseInput(flagSourceInputSchema, input);
  if (!parsed.ok) return parsed;
  const { feedSlug, storyId, sourceId, note } = parsed.data;
  return withActor({ needsName: true }, async (actor) => {
    try {
      await flagNoisy(sourceId, note, actor);
    } catch (error) {
      return serviceFailure(error);
    }
    revalidatePath(storyPath(feedSlug, storyId));
    revalidatePath(`/sources/${sourceId}`);
    revalidatePath("/sources");
    return ok(null, "Flagged as noisy.");
  });
}

/**
 * Adds one starter suggestion (§12) to the directory and to this feed. The
 * client sends only the name: the type, config, and why come from the
 * server's list, so a page cannot add a source with another config.
 */
export async function addSuggestionAction(
  input: AddSuggestionInput,
): Promise<ActionResult<{ sourceId: number; name: string; queuedStories: number }>> {
  const parsed = parseInput(addSuggestionInputSchema, input);
  if (!parsed.ok) return parsed;
  const { feedSlug, name } = parsed.data;
  return withActor({ needsName: true }, async (actor) => {
    const feed = await activeFeed(feedSlug);
    if (!feed) return fail(FEED_GONE, "not_found");
    const suggestion = (await listSuggestions(feed.slug)).find((s) => s.name === name);
    if (!suggestion) {
      return fail("This suggestion is in the source directory already. Reload the page.", "conflict");
    }
    let result: Awaited<ReturnType<typeof createFromWizard>>;
    try {
      result = await createFromWizard(
        {
          entries: [
            {
              type: suggestion.type,
              name: suggestion.name,
              config: suggestion.config,
              ...(suggestion.url ? { url: suggestion.url } : {}),
            },
          ],
          common: {
            why: suggestion.why,
            feedIds: [feed.id],
            follow: "",
            ignore: "",
            priority: "normal",
            checkIntervalMinutes: SOURCE_TYPE_DEFAULTS[suggestion.type].intervalMinutes,
            owner: actor.name,
          },
        },
        actor,
      );
    } catch (error) {
      return serviceFailure(error);
    }
    const created = result.created[0];
    if (!created) {
      return fail(result.skipped[0]?.reason ?? "The source was not added.", "conflict");
    }
    revalidatePath(feedPath(feed.slug));
    revalidatePath("/sources");
    return ok({ sourceId: created.id, name: created.name, queuedStories: result.queuedStories }, "Added");
  });
}
