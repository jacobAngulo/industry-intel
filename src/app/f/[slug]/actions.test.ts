import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/lib/services";

const revalidatePath = vi.fn();
const requireActor = vi.fn();
const getFeedBySlug = vi.fn();
const vote = vi.fn();
const requestAnalysis = vi.fn();
const flagNoisy = vi.fn();
const listSuggestions = vi.fn();
const createFromWizard = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("@/app/_lib/identity", () => ({ requireActor: (needsName: boolean) => requireActor(needsName) }));
vi.mock("@/lib/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services")>()),
  getFeedBySlug: (...args: unknown[]) => getFeedBySlug(...args),
  vote: (...args: unknown[]) => vote(...args),
  requestAnalysis: (...args: unknown[]) => requestAnalysis(...args),
  flagNoisy: (...args: unknown[]) => flagNoisy(...args),
  listSuggestions: (...args: unknown[]) => listSuggestions(...args),
  createFromWizard: (...args: unknown[]) => createFromWizard(...args),
}));

const { voteAction, requestAnalysisAction, flagSourceAction, addSuggestionAction } = await import("./actions");

const feed = { id: 1, slug: "agentic-development", archived: false };
const votes = { useful: 1, too_basic: 0, off_topic: 0, already_knew: 0 };

beforeEach(() => {
  for (const fn of [revalidatePath, requireActor, getFeedBySlug, vote, requestAnalysis, flagNoisy, listSuggestions, createFromWizard]) {
    fn.mockReset();
  }
  requireActor.mockResolvedValue({ name: "Ana", clientId: "c1" });
  getFeedBySlug.mockResolvedValue(feed);
});

describe("voteAction", () => {
  it("votes with no name and revalidates nothing from the list", async () => {
    vote.mockResolvedValue({ votes, myVote: "useful" });
    const result = await voteAction({ feedSlug: "agentic-development", storyId: 3, reason: "useful", from: "list" });
    expect(result).toEqual({ ok: true, data: { votes, myVote: "useful" } });
    expect(requireActor).toHaveBeenCalledWith(false);
    expect(vote).toHaveBeenCalledWith(1, 3, "useful", { name: "Ana", clientId: "c1" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates the story page for a vote from the story page", async () => {
    vote.mockResolvedValue({ votes, myVote: null });
    await voteAction({ feedSlug: "agentic-development", storyId: 3, reason: null, from: "story" });
    expect(revalidatePath).toHaveBeenCalledWith("/f/agentic-development/story/3");
  });

  it("refuses a bad input before any service call", async () => {
    const result = await voteAction({ feedSlug: "agentic-development", storyId: -1, reason: "useful", from: "list" });
    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(vote).not.toHaveBeenCalled();
  });

  it("answers not_found for an archived feed and maps a ServiceError", async () => {
    getFeedBySlug.mockResolvedValueOnce({ ...feed, archived: true });
    expect(await voteAction({ feedSlug: "a", storyId: 1, reason: "useful", from: "list" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    vote.mockRejectedValueOnce(new ServiceError("not_found", "This story is not in this feed."));
    expect(await voteAction({ feedSlug: "a", storyId: 1, reason: "useful", from: "list" })).toEqual({
      ok: false,
      code: "not_found",
      message: "This story is not in this feed.",
    });
  });
});

describe("actions that need a name", () => {
  it("answers needs_name with no display name", async () => {
    requireActor.mockResolvedValue(null);
    expect(await requestAnalysisAction({ feedSlug: "a", storyId: 1 })).toMatchObject({ ok: false, code: "needs_name" });
    expect(await flagSourceAction({ feedSlug: "a", storyId: 1, sourceId: 2 })).toMatchObject({ ok: false, code: "needs_name" });
    expect(await addSuggestionAction({ feedSlug: "a", name: "X" })).toMatchObject({ ok: false, code: "needs_name" });
    expect(requestAnalysis).not.toHaveBeenCalled();
    expect(flagNoisy).not.toHaveBeenCalled();
    expect(createFromWizard).not.toHaveBeenCalled();
  });

  it("queues the analysis and revalidates the story page", async () => {
    requestAnalysis.mockResolvedValue({ status: "queued" });
    expect(await requestAnalysisAction({ feedSlug: "agentic-development", storyId: 4 })).toEqual({
      ok: true,
      data: { status: "queued" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/f/agentic-development/story/4");
  });

  it("flags a source with the trimmed note", async () => {
    flagNoisy.mockResolvedValue(undefined);
    const result = await flagSourceAction({ feedSlug: "agentic-development", storyId: 4, sourceId: 2, note: " loud " });
    expect(result.ok).toBe(true);
    expect(flagNoisy).toHaveBeenCalledWith(2, "loud", { name: "Ana", clientId: "c1" });
  });
});

describe("addSuggestionAction", () => {
  const suggestion = {
    feedSlug: "agentic-development",
    type: "github",
    name: "Claude Code releases",
    why: "Releases of a coding agent that many teams use.",
    config: { owner: "anthropics", repo: "claude-code" },
    url: "https://github.com/anthropics/claude-code/releases",
  };

  it("adds the server's suggestion to the directory and this feed", async () => {
    listSuggestions.mockResolvedValue([suggestion]);
    createFromWizard.mockResolvedValue({ created: [{ id: 12, name: suggestion.name }], skipped: [], queuedStories: 0 });
    const result = await addSuggestionAction({ feedSlug: "agentic-development", name: "Claude Code releases" });
    expect(result).toEqual({ ok: true, data: { sourceId: 12, name: suggestion.name, queuedStories: 0 }, message: "Added" });
    expect(createFromWizard).toHaveBeenCalledWith(
      {
        entries: [{ type: "github", name: suggestion.name, config: suggestion.config, url: suggestion.url }],
        common: {
          why: suggestion.why,
          feedIds: [1],
          follow: "",
          ignore: "",
          priority: "normal",
          checkIntervalMinutes: 120,
          owner: "Ana",
        },
      },
      { name: "Ana", clientId: "c1" },
    );
    expect(revalidatePath).toHaveBeenCalledWith("/f/agentic-development");
  });

  it("refuses a name that is not a current suggestion", async () => {
    listSuggestions.mockResolvedValue([]);
    expect(await addSuggestionAction({ feedSlug: "agentic-development", name: "Evil" })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(createFromWizard).not.toHaveBeenCalled();
  });
});
