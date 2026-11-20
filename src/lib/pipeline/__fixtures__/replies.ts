// Model replies for the pipeline tests (snake_case, as the model writes them).
import type { AnalysisRaw, JudgeFeedResultRaw, JudgeItemFactsRaw, JudgeNormalRaw, JudgeSingleStoryRaw } from "../schemas";

export function feedResult(feedId: number, over: Partial<JudgeFeedResultRaw> = {}): JudgeFeedResultRaw {
  return {
    feed_id: feedId,
    relevance: 75,
    reason: "Directly useful for the platform work.",
    why_it_matters: "It changes the agent runtime that the platform team deploys.",
    suggested_action: null,
    topic_ids: [],
    exclusion: null,
    novelty: "new",
    depth: "intermediate",
    signals: { practical: 2, experiment: 1 },
    alert: false,
    ...over,
  };
}

export function itemFacts(over: Partial<JudgeItemFactsRaw> = {}): JudgeItemFactsRaw {
  return {
    headline: "Agent Service adds private networking for tools",
    summary: ["Agent Service now supports private networking for tool calls.", "The feature is in preview."],
    category: "feature",
    entities: ["Agent Service"],
    substance: "news",
    same_story_id: null,
    adds_new_facts: false,
    ...over,
  };
}

export function normalReply(
  feedIds: number[],
  item: Partial<JudgeItemFactsRaw> = {},
  feed: Partial<JudgeFeedResultRaw> | ((feedId: number) => Partial<JudgeFeedResultRaw>) = {},
): JudgeNormalRaw {
  return {
    item: itemFacts(item),
    feeds: feedIds.map((id) => feedResult(id, typeof feed === "function" ? feed(id) : feed)),
  };
}

export function singleReply(
  feedIds: number[],
  feed: Partial<JudgeFeedResultRaw> | ((feedId: number) => Partial<JudgeFeedResultRaw>) = {},
): JudgeSingleStoryRaw {
  return { feeds: feedIds.map((id) => feedResult(id, typeof feed === "function" ? feed(id) : feed)) };
}

export function analysisReply(over: Partial<AnalysisRaw> = {}): AnalysisRaw {
  return {
    what_changed: ["Private networking for tool calls is in preview."],
    how_it_works: ["Tool calls go through a private endpoint in the virtual network."],
    what_it_means_for_us: ["The platform team can keep tool traffic off the public internet."],
    risks_and_limits: ["Preview: no service level agreement."],
    suggested_actions: [
      { action: "Test a private endpoint in the dev subscription", why: "It removes a blocker.", effort: "experiment", first_step: "Create the endpoint." },
    ],
    open_questions: ["When is general availability?"],
    confidence: "medium",
    confidence_note: "The sources do not say the price.",
    sources_used: [],
    ...over,
  };
}
