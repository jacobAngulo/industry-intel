import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LlmError, type LlmErrorKind } from "@/lib/llm/types";
import { DAY_MS, HOUR_MS, MINUTE_MS, nextUtcMidnight } from "@/lib/time";
import {
  FakeHttp,
  FakeLlm,
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeStory,
  makeTopic,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { feedResult, normalReply, singleReply } from "./__fixtures__/replies";
import { readLlmPause, setLlmPause } from "./jobs";
import { judgeDraft, judgeItem } from "./judge";
import type { PipelineDeps } from "./types";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;
let clock: number;
let llm: FakeLlm;
let deps: PipelineDeps;

beforeEach(() => {
  t = installTestDb();
  clock = NOW;
  setNowForTests(() => clock);
  llm = new FakeLlm();
  deps = { llm, http: new FakeHttp(), search: null, mail: null, now: () => clock };
});

afterEach(() => {
  t.cleanup();
});

type ItemRow = {
  judge_status: string;
  skip_reason: string | null;
  story_id: number | null;
  substance: string | null;
  judge_attempts: number;
  judge_error: string | null;
  next_judge_at: number | null;
  judge_locked_until: number | null;
  meta: string;
};
type StoryRow = {
  id: number;
  headline: string;
  summary: string;
  substance: string;
  fresh_at: number;
  first_seen_at: number;
  last_item_at: number;
  item_count: number;
  source_count: number;
  primary_item_id: number | null;
  primary_url: string | null;
};
type JudgementRow = {
  id: number;
  feed_id: number;
  relevance: number;
  topic_ids: string;
  exclusion: string | null;
  base_score: number;
  hidden_reason: string | null;
  source_item_id: number | null;
  created_at: number;
  judged_at: number;
};

const itemRow = (id: number) => t.sqlite.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow;
const storyRow = (id: number) => t.sqlite.prepare("SELECT * FROM stories WHERE id = ?").get(id) as StoryRow;
const judgementsOf = (storyId: number) =>
  t.sqlite.prepare("SELECT * FROM judgements WHERE story_id = ? ORDER BY feed_id").all(storyId) as JudgementRow[];
const alertRows = () => t.sqlite.prepare("SELECT feed_id, story_id, visible_at FROM alerts").all();

function platform(over: Parameters<typeof makeFeed>[0] = {}) {
  const feed = makeFeed({ name: "Internal AI Platform", ...over });
  const source = makeSource({ name: "Foundry blog" });
  linkFeedSource(feed.id, source.id);
  return { feed, source };
}

/** An existing story with one item of another source (that feed uses it too). */
function existingStory(feedId: number, over: Parameters<typeof makeStory>[0] = {}, itemOver: Partial<Parameters<typeof makeItem>[0]> = {}) {
  const other = makeSource({ name: "Other source" });
  linkFeedSource(feedId, other.id);
  const story = makeStory({
    headline: "Agent Service private networking preview",
    summary: ["Old fact one.", "Old fact two."],
    createdAt: NOW - DAY_MS,
    firstSeenAt: NOW - DAY_MS,
    lastItemAt: NOW - DAY_MS,
    freshAt: NOW - DAY_MS,
    ...over,
  });
  const item = makeItem({ sourceId: other.id, storyId: story.id, url: "https://other.example.com/story", ...itemOver });
  return { story, item, other };
}

describe("judgeItem: normal mode", () => {
  it("creates a new story, inserts the judgement, recomputes the rank, and marks the item judged", async () => {
    const { feed, source } = platform();
    const topic = makeTopic({ name: "Microsoft Foundry" });
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking", publishedAt: NOW - 2 * HOUR_MS });
    llm.enqueue(normalReply([feed.id], {}, { relevance: 80, topic_ids: [topic.id, 9999] }));

    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "judged" });

    const after = itemRow(item.id);
    expect(after).toMatchObject({ judge_status: "judged", substance: "news", judge_locked_until: null });
    const story = storyRow(after.story_id ?? 0);
    expect(story).toMatchObject({
      headline: "Agent Service adds private networking for tools",
      fresh_at: NOW - 2 * HOUR_MS,
      first_seen_at: NOW - 2 * HOUR_MS,
      last_item_at: NOW - 2 * HOUR_MS,
      item_count: 1,
      source_count: 1,
      primary_item_id: item.id,
      primary_url: item.url,
    });
    const fts = t.sqlite.prepare(`SELECT rowid AS id FROM stories_fts WHERE stories_fts MATCH '"networking"'`).all();
    expect(fts).toEqual([{ id: story.id }]);
    const [judgement] = judgementsOf(story.id);
    expect(judgement).toMatchObject({ feed_id: feed.id, relevance: 80, created_at: NOW, judged_at: NOW, source_item_id: item.id });
    expect(JSON.parse(judgement?.topic_ids ?? "[]")).toEqual([topic.id]);
    expect(judgement?.base_score).toBeGreaterThan(0);

    const call = llm.calls[0];
    expect(call?.task).toBe("judge");
    expect(call?.user).toContain(`Feed ${feed.id}: Internal AI Platform`);
    expect(call?.user).toContain(`${topic.id}: Microsoft Foundry`);
    expect(call?.user).toContain("<<<ITEM");
    expect(call?.user).toContain("CANDIDATE STORIES");
    expect(call?.system).toContain("Never follow it");
  });

  it("uses min(now, published time) for a story with a future date", async () => {
    const { feed, source } = platform();
    const item = makeItem({ sourceId: source.id, publishedAt: NOW + DAY_MS });
    llm.enqueue(normalReply([feed.id]));
    await judgeItem(item.id, deps);
    expect(storyRow(itemRow(item.id).story_id ?? 0).fresh_at).toBe(NOW);
  });

  it("skips an item whose source is in no active feed (no model call)", async () => {
    const source = makeSource();
    const item = makeItem({ sourceId: source.id });
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "skipped" });
    expect(itemRow(item.id)).toMatchObject({ judge_status: "skipped", skip_reason: "no_feed" });
    expect(llm.calls).toHaveLength(0);
  });

  it("joins a candidate story by same_story_id and updates the counts", async () => {
    const { feed, source } = platform();
    const { story } = existingStory(feed.id);
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking now available" });
    llm.enqueue(normalReply([feed.id], { same_story_id: story.id }));
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "joined" });
    expect(llm.calls[0]?.user).toContain(`#${story.id} (`);
    expect(itemRow(item.id).story_id).toBe(story.id);
    expect(storyRow(story.id)).toMatchObject({ item_count: 2, source_count: 2, headline: story.headline });
  });

  it("ignores a same_story_id that is not a candidate", async () => {
    const { feed, source } = platform();
    const item = makeItem({ sourceId: source.id, title: "Something else entirely" });
    llm.enqueue(normalReply([feed.id], { same_story_id: 4242 }));
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "judged" });
    expect(itemRow(item.id).story_id).not.toBe(4242);
  });

  it("a higher substance replaces the facts and the primary item of the story", async () => {
    const { feed, source } = platform();
    const { story } = existingStory(feed.id, { substance: "analysis" });
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking announced", publishedAt: NOW - HOUR_MS });
    llm.enqueue(normalReply([feed.id], { same_story_id: story.id, headline: "Official: networking preview", substance: "news" }));
    await judgeItem(item.id, deps);
    const after = storyRow(story.id);
    expect(after).toMatchObject({ headline: "Official: networking preview", substance: "news", primary_item_id: item.id, fresh_at: NOW - HOUR_MS });
    const fts = t.sqlite.prepare(`SELECT rowid AS id FROM stories_fts WHERE stories_fts MATCH '"official"'`).all();
    expect(fts).toEqual([{ id: story.id }]);
  });

  it("adds_new_facts puts the item sentences first, removes exact duplicates, and cuts to 5", async () => {
    const { feed, source } = platform();
    const { story } = existingStory(feed.id, { summary: ["Old one.", "Old two.", "Old three.", "Old four."] });
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking pricing" });
    llm.enqueue(normalReply([feed.id], { same_story_id: story.id, adds_new_facts: true, summary: ["New fact.", "Old one."] }));
    await judgeItem(item.id, deps);
    expect(JSON.parse(storyRow(story.id).summary)).toEqual(["New fact.", "Old one.", "Old two.", "Old three.", "Old four."]);
    expect(storyRow(story.id).fresh_at).toBe(NOW);
  });

  it("fresh_at never moves back", async () => {
    const { feed, source } = platform();
    const { story } = existingStory(feed.id, { freshAt: NOW - HOUR_MS, lastItemAt: NOW - HOUR_MS });
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking details", publishedAt: NOW - 5 * HOUR_MS });
    llm.enqueue(normalReply([feed.id], { same_story_id: story.id, adds_new_facts: true }));
    await judgeItem(item.id, deps);
    expect(storyRow(story.id).fresh_at).toBe(NOW - HOUR_MS);
  });

  it("regroup: a matching story created during the call sends the item back once", async () => {
    const { feed, source } = platform();
    const item = makeItem({ sourceId: source.id, title: "Foundry agents private networking" });
    const reply = normalReply([feed.id]);
    llm.enqueue(() => {
      clock += 1000;
      makeStory({ headline: "Foundry agents private networking", lastItemAt: clock });
      return reply;
    });
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "regroup" });
    expect(itemRow(item.id)).toMatchObject({ judge_status: "pending", judge_locked_until: null, story_id: null });
    expect(JSON.parse(itemRow(item.id).meta)).toMatchObject({ regroup: true });

    llm.enqueue(() => {
      clock += 1000;
      makeStory({ headline: "Foundry agents private networking again", lastItemAt: clock });
      return reply;
    });
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "judged" });
    expect(llm.calls[1]?.user).toContain("Foundry agents private networking");
  });

  it("drops results for feeds that are archived or stop using the source during the call", async () => {
    const { feed, source } = platform();
    const archived = makeFeed();
    const removed = makeFeed();
    linkFeedSource(archived.id, source.id);
    linkFeedSource(removed.id, source.id);
    const item = makeItem({ sourceId: source.id });
    llm.enqueue(() => {
      t.sqlite.prepare("UPDATE feeds SET archived_at = ? WHERE id = ?").run(NOW, archived.id);
      t.sqlite.prepare("DELETE FROM feed_sources WHERE feed_id = ?").run(removed.id);
      return normalReply([feed.id, archived.id, removed.id]);
    });
    await judgeItem(item.id, deps);
    const storyId = itemRow(item.id).story_id ?? 0;
    expect(judgementsOf(storyId).map((row) => row.feed_id)).toEqual([feed.id]);
    expect(itemRow(item.id).judge_status).toBe("judged");
  });

  it("keeps the item pending (single-story mode next) when a feed of its source has no result", async () => {
    const { feed, source } = platform();
    const late = makeFeed();
    const item = makeItem({ sourceId: source.id });
    llm.enqueue(() => {
      linkFeedSource(late.id, source.id); // a feed starts to use the source during the call
      return normalReply([feed.id]);
    });
    await judgeItem(item.id, deps);
    const after = itemRow(item.id);
    expect(after.judge_status).toBe("pending");
    expect(after.story_id).not.toBeNull();
    expect(after.judge_locked_until).toBeNull();
  });

  it("a promo story found by link is a certain candidate; a news item replaces its facts", async () => {
    const { feed, source } = platform();
    const { story } = existingStory(feed.id, { substance: "promo", headline: "Webinar about networking" }, { url: "https://vendor.example.com/launch" });
    makeJudgement({ feedId: feed.id, storyId: story.id });
    const item = makeItem({ sourceId: source.id, url: "https://vendor.example.com/launch", title: "Launch details" });
    llm.enqueue(normalReply([feed.id], { headline: "Vendor launches private networking", substance: "news" }));
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "joined" });
    expect(llm.calls[0]?.user).toContain(`#${story.id}`);
    expect(llm.calls[0]?.user).toContain("shares a link with the item");
    expect(storyRow(story.id)).toMatchObject({ headline: "Vendor launches private networking", substance: "news" });
  });
});

describe("judgeItem: the replace rules of a judgement", () => {
  async function judgeJoining(opts: {
    oldText: number;
    newText: number;
    oldRelevance?: number;
    oldExclusion?: string | null;
    oldFromSameSource?: boolean;
    reply: { relevance?: number; exclusion?: string | null; adds_new_facts?: boolean };
  }) {
    const { feed, source } = platform();
    const { story, item: oldItem } = existingStory(feed.id, {}, { contentText: "x".repeat(opts.oldText) });
    const producer = opts.oldFromSameSource ? makeItem({ sourceId: source.id, storyId: story.id, contentText: "y".repeat(opts.oldText) }) : oldItem;
    const old = makeJudgement({
      feedId: feed.id,
      storyId: story.id,
      relevance: opts.oldRelevance ?? 50,
      exclusion: opts.oldExclusion ?? null,
      sourceItemId: producer.id,
      createdAt: NOW - DAY_MS,
      judgedAt: NOW - DAY_MS,
    });
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking update", contentText: "z".repeat(opts.newText) });
    llm.enqueue(
      normalReply(
        [feed.id],
        { same_story_id: story.id, adds_new_facts: opts.reply.adds_new_facts ?? false },
        { relevance: opts.reply.relevance ?? 70, exclusion: opts.reply.exclusion ?? null },
      ),
    );
    await judgeItem(item.id, deps);
    const [row] = judgementsOf(story.id);
    return { row: row as JudgementRow, old, item };
  }

  it("replaces when the new item has at least 1.5 times the text (created_at stays)", async () => {
    const { row, item } = await judgeJoining({ oldText: 100, newText: 150, reply: { relevance: 70 } });
    expect(row).toMatchObject({ relevance: 70, created_at: NOW - DAY_MS, judged_at: NOW, source_item_id: item.id });
  });

  it("keeps the judgement for a shorter item that adds no new facts", async () => {
    const { row } = await judgeJoining({ oldText: 100, newText: 120, reply: { relevance: 70 } });
    expect(row.relevance).toBe(50);
  });

  it("replaces when the item adds new facts and the relevance is higher, not when it is lower", async () => {
    expect((await judgeJoining({ oldText: 100, newText: 120, reply: { relevance: 70, adds_new_facts: true } })).row.relevance).toBe(70);
  });

  it("keeps the judgement when new facts come with a lower relevance", async () => {
    expect((await judgeJoining({ oldText: 100, newText: 120, reply: { relevance: 40, adds_new_facts: true } })).row.relevance).toBe(50);
  });

  it("replaces a 'source filter' judgement of a different source", async () => {
    const { row } = await judgeJoining({ oldText: 100, newText: 10, oldExclusion: "source filter", reply: { relevance: 72 } });
    expect(row).toMatchObject({ relevance: 72, exclusion: null });
  });

  it("a 'source filter' result never replaces a judgement with no exclusion", async () => {
    const { row } = await judgeJoining({ oldText: 10, newText: 1000, reply: { relevance: 20, exclusion: "source filter" } });
    expect(row).toMatchObject({ relevance: 50, exclusion: null });
  });
});

describe("judgeItem: single-story mode", () => {
  it("judges only the feeds that need a judgement, with the story brief and no item facts", async () => {
    const feedA = makeFeed();
    const feedB = makeFeed();
    const source = makeSource();
    linkFeedSource(feedA.id, source.id);
    linkFeedSource(feedB.id, source.id);
    const { story } = existingStory(feedA.id, {}, { url: "https://example.com/shared" });
    const judgementA = makeJudgement({ feedId: feedA.id, storyId: story.id, relevance: 66 });
    const item = makeItem({ sourceId: source.id, url: "https://example.com/shared" });
    llm.enqueue(singleReply([feedB.id], { relevance: 81 }));

    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "judged" });
    const call = llm.calls[0];
    expect(call?.user).toContain(`STORY #${story.id}`);
    expect(call?.user).not.toContain("CANDIDATE STORIES");
    expect(call?.system).toContain('Return only the "feeds" list');
    expect(call?.user).toContain(`Feed ${feedB.id}:`);
    expect(call?.user).not.toContain(`Feed ${feedA.id}:`);
    const rows = judgementsOf(story.id);
    expect(rows.map((row) => [row.feed_id, row.relevance])).toEqual([
      [feedA.id, 66],
      [feedB.id, 81],
    ]);
    expect(rows[0]?.id).toBe(judgementA.id);
    expect(itemRow(item.id)).toMatchObject({ judge_status: "judged", story_id: story.id });
  });

  it("a silent join with no feed left to judge needs no model call", async () => {
    const { feed, source } = platform();
    const { story } = existingStory(feed.id, {}, { url: "https://example.com/shared" });
    makeJudgement({ feedId: feed.id, storyId: story.id });
    const item = makeItem({ sourceId: source.id, url: "https://example.com/shared" });
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "joined" });
    expect(llm.calls).toHaveLength(0);
    expect(itemRow(item.id)).toMatchObject({ judge_status: "judged", story_id: story.id });
  });
});

describe("judgeItem: model errors", () => {
  async function failWith(error: LlmError, attempts = 0) {
    const { source } = platform();
    const item = makeItem({ sourceId: source.id, judgeAttempts: attempts, judgeLockedUntil: NOW + MINUTE_MS });
    llm.enqueue(error);
    const result = await judgeItem(item.id, deps);
    return { result, item: itemRow(item.id), pause: readLlmPause() };
  }

  it.each<[LlmErrorKind, number]>([
    ["overloaded", 2 * MINUTE_MS],
    ["network", 2 * MINUTE_MS],
    ["rate_limited", 10 * MINUTE_MS],
    ["auth", 60 * MINUTE_MS],
    ["payment", 60 * MINUTE_MS],
    ["not_found", 60 * MINUTE_MS],
    ["no_key", 60 * MINUTE_MS],
  ])("%s pauses the model and does not count an attempt", async (kind, pauseMs) => {
    const { result, item, pause } = await failWith(new LlmError(kind, "detail"));
    expect(result).toEqual({ outcome: "paused" });
    expect(item).toMatchObject({ judge_status: "pending", judge_attempts: 0, judge_locked_until: null });
    expect(pause.pausedUntil).toBe(NOW + pauseMs);
    expect(pause.lastError).toEqual(expect.any(String));
  });

  it("budget pauses until the next UTC midnight", async () => {
    const { pause } = await failWith(new LlmError("budget", "used"));
    expect(pause.pausedUntil).toBe(nextUtcMidnight(NOW));
  });

  it("auth, payment, and not_found write an error event", async () => {
    await failWith(new LlmError("payment", "no credits"));
    expect(t.sqlite.prepare("SELECT level, scope FROM events").all()).toEqual([{ level: "error", scope: "model" }]);
  });

  it("the pause doubles for overloaded (up to 30 min) and rate_limited (up to 60 min)", async () => {
    setLlmPause({ until: NOW - 1, step: 1, lastError: "x" }, NOW);
    expect((await failWith(new LlmError("overloaded", "busy"))).pause).toMatchObject({ pausedUntil: NOW + 4 * MINUTE_MS, step: 2 });
    setLlmPause({ until: NOW - 1, step: 5, lastError: "x" }, NOW);
    expect((await failWith(new LlmError("overloaded", "busy"))).pause.pausedUntil).toBe(NOW + 30 * MINUTE_MS);
    setLlmPause({ until: NOW - 1, step: 3, lastError: "x" }, NOW);
    expect((await failWith(new LlmError("rate_limited", "slow"))).pause.pausedUntil).toBe(NOW + 60 * MINUTE_MS);
  });

  it("rate_limited uses retryAfterMs when it is larger", async () => {
    const { pause } = await failWith(new LlmError("rate_limited", "slow", { retryAfterMs: 15 * MINUTE_MS }));
    expect(pause.pausedUntil).toBe(NOW + 15 * MINUTE_MS);
  });

  it.each<LlmErrorKind>(["bad_output", "bad_request"])("%s counts an attempt with a back-off and no pause", async (kind) => {
    const { result, item, pause } = await failWith(new LlmError(kind, "The reply was not valid."), 1);
    expect(result).toEqual({ outcome: "retry" });
    expect(item).toMatchObject({ judge_status: "pending", judge_attempts: 2, judge_error: "The reply was not valid.", next_judge_at: NOW + 4 * MINUTE_MS });
    expect(pause.pausedUntil).toBeNull();
  });

  it("a timeout counts an attempt and pauses the model for 2 minutes", async () => {
    const { result, item, pause } = await failWith(new LlmError("timeout", "slow"));
    expect(result).toEqual({ outcome: "retry" });
    expect(item.judge_attempts).toBe(1);
    expect(item.next_judge_at).toBe(NOW + 2 * MINUTE_MS);
    expect(pause.pausedUntil).toBe(NOW + 2 * MINUTE_MS);
  });

  it("the fifth item error marks the item failed", async () => {
    const { result, item } = await failWith(new LlmError("bad_output", "bad"), 4);
    expect(result).toEqual({ outcome: "failed" });
    expect(item).toMatchObject({ judge_status: "failed", judge_attempts: 5, next_judge_at: null });
  });

  it("an unexpected error of the provider counts as an item error", async () => {
    const { source } = platform();
    const item = makeItem({ sourceId: source.id });
    llm.enqueue(() => {
      throw new Error("socket hang up");
    });
    expect(await judgeItem(item.id, deps)).toEqual({ outcome: "retry" });
    expect(itemRow(item.id).judge_error).toContain("socket hang up");
  });

  it("a successful call clears the pause state", async () => {
    setLlmPause({ until: NOW - 1, step: 3, lastError: "the model service is overloaded" }, NOW);
    const { feed, source } = platform();
    const item = makeItem({ sourceId: source.id });
    llm.enqueue(normalReply([feed.id]));
    await judgeItem(item.id, deps);
    expect(readLlmPause()).toEqual({ pausedUntil: null, step: 0, lastError: null });
  });
});

describe("judgeItem: alerts (§9.3)", () => {
  const alertsOn = { enabled: true, rule: "A breaking change in Foundry", minRelevance: 85 };

  async function judgeWithAlert(feedOver: Parameters<typeof makeFeed>[0], reply: { relevance: number; alert: boolean }) {
    const { feed, source } = platform(feedOver);
    const item = makeItem({ sourceId: source.id });
    llm.enqueue(normalReply([feed.id], {}, reply));
    await judgeItem(item.id, deps);
    return { feed, storyId: itemRow(item.id).story_id };
  }

  it("creates one visible alert when the rule matches, the score is high enough, and the story is visible", async () => {
    const { feed, storyId } = await judgeWithAlert({ alerts: alertsOn }, { relevance: 90, alert: true });
    expect(alertRows()).toEqual([{ feed_id: feed.id, story_id: storyId, visible_at: NOW }]);
    expect(llm.calls[0]?.user).toContain("Alert rule: A breaking change in Foundry");
  });

  it("no alert below alerts.minRelevance, with alert = false, or with alerts off", async () => {
    await judgeWithAlert({ alerts: alertsOn }, { relevance: 84, alert: true });
    await judgeWithAlert({ alerts: alertsOn }, { relevance: 95, alert: false });
    await judgeWithAlert({ alerts: { ...alertsOn, enabled: false } }, { relevance: 95, alert: true });
    expect(alertRows()).toEqual([]);
    expect(llm.calls[2]?.user).not.toContain("Alert rule:");
  });

  it("no alert for a hidden judgement", async () => {
    await judgeWithAlert({ alerts: alertsOn, minRelevance: 95 }, { relevance: 90, alert: true });
    expect(alertRows()).toEqual([]);
  });

  it("inside the quiet hours the alert becomes visible at their end", async () => {
    const quietHours = { enabled: true, start: "08:00", end: "18:00" };
    await judgeWithAlert({ alerts: alertsOn, quietHours }, { relevance: 90, alert: true });
    expect(alertRows()).toEqual([expect.objectContaining({ visible_at: Date.UTC(2026, 10, 20, 18, 0, 0) })]);
  });

  it("no alert for a story whose fresh_at is older than 48 hours", async () => {
    const { feed, source } = platform({ alerts: alertsOn });
    const { story } = existingStory(feed.id, { freshAt: NOW - 3 * DAY_MS, lastItemAt: NOW - 3 * DAY_MS });
    const item = makeItem({ sourceId: source.id, title: "Agent Service private networking", publishedAt: NOW - 3 * DAY_MS });
    llm.enqueue(normalReply([feed.id], { same_story_id: story.id }, { relevance: 95, alert: true }));
    await judgeItem(item.id, deps);
    expect(itemRow(item.id).story_id).toBe(story.id);
    expect(alertRows()).toEqual([]);
  });

  it("one alert for each feed and story", async () => {
    const { feed, source } = platform({ alerts: alertsOn });
    const first = makeItem({ sourceId: source.id, contentText: "short" });
    llm.enqueue(normalReply([feed.id], {}, { relevance: 90, alert: true }));
    await judgeItem(first.id, deps);
    const storyId = itemRow(first.id).story_id ?? 0;
    const second = makeItem({ sourceId: makeSource().id, contentText: "a much longer text ".repeat(20) });
    linkFeedSource(feed.id, second.sourceId);
    llm.enqueue(normalReply([feed.id], { same_story_id: storyId, headline: "Story 1" }, { relevance: 92, alert: true }));
    // The FTS search must find the story: give the second item the same title words.
    t.sqlite.prepare("UPDATE items SET title = ? WHERE id = ?").run("Agent Service private networking", second.id);
    await judgeItem(second.id, deps);
    expect(itemRow(second.id).story_id).toBe(storyId);
    expect(alertRows()).toHaveLength(1);
  });
});

describe("judgeDraft", () => {
  it("returns the verdict for each feed with the hidden reason and writes nothing", async () => {
    const feed = makeFeed({ minRelevance: 60 });
    const muted = makeTopic({ name: "Funding" });
    t.sqlite.prepare("INSERT INTO feed_topics (feed_id, topic_id, priority) VALUES (?, ?, 'muted')").run(feed.id, muted.id);
    const other = makeFeed();
    const third = makeFeed();
    const tables = ["items", "stories", "judgements", "alerts", "events", "worker_state"];
    const count = () => tables.map((table) => (t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const before = count();
    llm.enqueue({
      item: normalReply([]).item,
      feeds: [
        feedResult(feed.id, { relevance: 40 }),
        feedResult(other.id, { relevance: 80, exclusion: "Politics" }),
        feedResult(third.id, { relevance: 80, topic_ids: [muted.id] }),
      ],
    });
    const result = await judgeDraft({
      item: { externalId: "x", title: "A draft item", kind: "article", text: "Some text." },
      source: { name: "Draft blog", type: "blog" },
      feeds: [
        { feedId: feed.id, follow: "agents, permissions", ignore: "webinars", priority: "high" },
        { feedId: other.id, follow: "", ignore: "", priority: "normal" },
        { feedId: third.id, follow: "", ignore: "", priority: "normal" },
      ],
      deps,
    });
    expect(result).toEqual([
      expect.objectContaining({ feedId: feed.id, relevance: 40, hiddenReason: "below_threshold" }),
      expect.objectContaining({ feedId: other.id, relevance: 80, hiddenReason: "exclusion" }),
      expect.objectContaining({ feedId: third.id, hiddenReason: null }),
    ]);
    expect(count()).toEqual(before);
    expect(llm.calls[0]?.usageMetric).toBe("llm_calls_preview");
    expect(llm.calls[0]?.user).toContain("Follow (take only these subjects from this source): agents, permissions");
    expect(llm.calls[0]?.user).toContain("Ignore (never take these from this source): webinars");
    expect(llm.calls[0]?.user).toContain("(none)");
  });

  it("marks a muted topic of the feed", async () => {
    const feed = makeFeed();
    const muted = makeTopic({ name: "Funding" });
    t.sqlite.prepare("INSERT INTO feed_topics (feed_id, topic_id, priority) VALUES (?, ?, 'muted')").run(feed.id, muted.id);
    llm.enqueue(normalReply([feed.id], {}, { relevance: 80, topic_ids: [muted.id] }));
    const [result] = await judgeDraft({
      item: { externalId: "x", title: "Draft", kind: "article", text: "Text." },
      source: { name: "Draft blog", type: "blog" },
      feeds: [{ feedId: feed.id, follow: "", ignore: "", priority: "normal" }],
      deps,
    });
    expect(result?.hiddenReason).toBe("muted_topic");
  });

  it("throws the LlmError of the model and sets no pause", async () => {
    const feed = makeFeed();
    llm.enqueue(new LlmError("overloaded", "The model service is busy."));
    await expect(
      judgeDraft({
        item: { externalId: "x", title: "Draft", kind: "article", text: "Text." },
        source: { name: "Draft blog", type: "blog" },
        feeds: [{ feedId: feed.id, follow: "", ignore: "", priority: "normal" }],
        deps,
      }),
    ).rejects.toMatchObject({ name: "LlmError", kind: "overloaded" });
    expect(readLlmPause().pausedUntil).toBeNull();
  });
});
