import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSqlite } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { setLlmPause, writeWorkerState } from "@/lib/pipeline/jobs";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "@/lib/time";
import type { UsageMetric } from "@/lib/types";
import { createUsageMeter } from "@/lib/usage";
import {
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeSource,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { NOW, feedWithSource, judgedStory } from "./_read-testkit";
import { getBanners, getStatus, retryFailedItems } from "./status";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
  // No real key in a test; each test sets the values that it needs.
  vi.stubEnv("OLLAMA_API_KEY", "");
  vi.stubEnv("LLM_MAX_CALLS_PER_DAY", "");
  vi.stubEnv("X_MAX_POSTS_PER_DAY", "");
  vi.stubEnv("WEB_SEARCH_MAX_PER_DAY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  t.cleanup();
});

function beat(ageMs: number, keys: { model?: boolean; x?: boolean; mail?: boolean } = {}): void {
  writeWorkerState("heartbeat", {
    at: NOW - ageMs,
    hasModelKey: keys.model ?? true,
    hasXToken: keys.x ?? false,
    hasMailbox: keys.mail ?? false,
  });
}

function use(metric: UsageMetric, n: number): void {
  createUsageMeter(getEnv()).add(metric, n);
}

function addEvent(level: string, at: number, message = `${level} at ${at}`): void {
  getSqlite().prepare("INSERT INTO events (at, level, scope, message) VALUES (?, ?, 'test', ?)").run(at, level, message);
}

const kinds = (banners: Awaited<ReturnType<typeof getBanners>>) => banners.map((b) => b.kind);

describe("getStatus", () => {
  it("reports the worker from the heartbeat", async () => {
    expect((await getStatus()).worker).toEqual({ alive: false, lastBeatAt: null, hasModelKey: false, hasXToken: false, hasMailbox: false });
    beat(10 * SECOND_MS, { model: true, x: true, mail: false });
    expect((await getStatus()).worker).toEqual({ alive: true, lastBeatAt: NOW - 10 * SECOND_MS, hasModelKey: true, hasXToken: true, hasMailbox: false });
    beat(31 * SECOND_MS);
    expect((await getStatus()).worker.alive).toBe(false);
  });

  it("reports the model names, the pause, and the counters of today against the limits", async () => {
    vi.stubEnv("OLLAMA_MODEL_JUDGE", "judge-model");
    vi.stubEnv("LLM_MAX_CALLS_PER_DAY", "40");
    vi.stubEnv("X_MAX_POSTS_PER_DAY", "70");
    vi.stubEnv("WEB_SEARCH_MAX_PER_DAY", "9");
    use("llm_calls", 12);
    use("llm_calls_preview", 3);
    use("llm_input_tokens", 1000);
    use("llm_output_tokens", 200);
    use("x_posts", 25);
    use("web_searches", 4);
    setLlmPause({ until: NOW + 10 * MINUTE_MS, step: 1, lastError: "The service is busy" });

    const status = await getStatus();
    expect(status.model).toMatchObject({
      judgeModel: "judge-model",
      pausedUntil: NOW + 10 * MINUTE_MS,
      lastError: "The service is busy",
      callsToday: 12,
      callLimit: 40,
      previewCallsToday: 3,
      inputTokensToday: 1000,
      outputTokensToday: 200,
    });
    expect(status.model.analysisModel).toBe(getEnv().ollamaModelAnalysis);
    expect(status.x).toEqual({ postsToday: 25, postLimit: 70 });
    expect(status.webSearch).toEqual({ searchesToday: 4, limit: 9 });
  });

  it("does not report a pause that is over", async () => {
    setLlmPause({ until: NOW - MINUTE_MS, step: 1, lastError: "Old" });
    expect((await getStatus()).model.pausedUntil).toBeNull();
  });

  it("counts the queues", async () => {
    const { feed, source } = feedWithSource();
    makeItem({ sourceId: source.id });
    makeItem({ sourceId: source.id });
    makeItem({ sourceId: source.id, judgeStatus: "failed" });
    const a = judgedStory(feed.id, source.id).story;
    const b = judgedStory(feed.id, source.id).story;
    const sqlite = getSqlite();
    const analysis = sqlite.prepare(
      "INSERT INTO analyses (feed_id, story_id, status, requested_by, requested_at, updated_at) VALUES (?, ?, ?, 'T', 0, 0)",
    );
    analysis.run(feed.id, a.id, "queued");
    analysis.run(feed.id, b.id, "done");
    const rejudge = sqlite.prepare(
      `INSERT INTO rejudge_requests (feed_id, since_at, status, total, done, failed, requested_by, requested_at, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, 'T', 0, 0)`,
    );
    rejudge.run(feed.id, "running", 10, 3, 1);
    rejudge.run(feed.id, "queued", 4, 0, 0);
    rejudge.run(feed.id, "done", 7, 7, 0);

    expect((await getStatus()).queues).toEqual({ itemsPending: 2, itemsFailed: 1, analysesQueued: 1, rejudgeQueued: 10 });
  });

  it("lists every unpaused source whose last check failed, the most failures first", async () => {
    const failing = makeSource({ name: "Broken", consecutiveFailures: 3, lastError: "404", nextCheckAt: NOW + HOUR_MS });
    const once = makeSource({ name: "Once", consecutiveFailures: 1, lastError: "timeout", nextCheckAt: NOW + MINUTE_MS });
    const credits = makeSource({ name: "Credits", consecutiveFailures: 0, lastError: "No credits", nextCheckAt: NOW + 2 * HOUR_MS });
    makeSource({ consecutiveFailures: 2 });
    makeSource({ name: "Paused", paused: true, consecutiveFailures: 5, lastError: "500" });
    expect((await getStatus()).failingSources).toEqual([
      { id: failing.id, name: "Broken", lastError: "404", nextCheckAt: NOW + HOUR_MS, consecutiveFailures: 3 },
      { id: once.id, name: "Once", lastError: "timeout", nextCheckAt: NOW + MINUTE_MS, consecutiveFailures: 1 },
      { id: credits.id, name: "Credits", lastError: "No credits", nextCheckAt: NOW + 2 * HOUR_MS, consecutiveFailures: 0 },
    ]);
  });

  it("lists the last 50 warn and error events, newest first", async () => {
    for (let i = 0; i < 55; i += 1) addEvent(i % 2 === 0 ? "warn" : "error", NOW - i * SECOND_MS);
    addEvent("info", NOW + SECOND_MS);
    const events = (await getStatus()).events;
    expect(events).toHaveLength(50);
    expect(events[0]).toEqual({ at: NOW, level: "warn", scope: "test", message: `warn at ${NOW}` });
    expect(events.every((event) => event.level !== ("info" as string))).toBe(true);
  });
});

describe("getBanners", () => {
  it("shows worker_down when the heartbeat is absent or older than 30 s", async () => {
    expect(kinds(await getBanners())).toContain("worker_down");
    beat(5 * SECOND_MS);
    expect(kinds(await getBanners())).not.toContain("worker_down");
    beat(30 * SECOND_MS);
    const banners = await getBanners();
    expect(banners.find((b) => b.kind === "worker_down")).toMatchObject({
      tone: "warning",
      message: "The worker is not running, so nothing new arrives. Start the app with npm run dev or npm start.",
    });
  });

  it("shows no_model_key from the heartbeat, else from the web environment", async () => {
    beat(1000, { model: false });
    vi.stubEnv("OLLAMA_API_KEY", "web-has-one");
    expect(kinds(await getBanners())).toContain("no_model_key");
    beat(1000, { model: true });
    vi.stubEnv("OLLAMA_API_KEY", "");
    expect(kinds(await getBanners())).not.toContain("no_model_key");

    getSqlite().prepare("DELETE FROM worker_state WHERE key = 'heartbeat'").run();
    expect((await getBanners()).find((b) => b.kind === "no_model_key")?.message).toBe(
      "The model key is missing. Add OLLAMA_API_KEY to the .env file and start the app again. The worker still checks the sources; items wait for the model.",
    );
    vi.stubEnv("OLLAMA_API_KEY", "web-has-one");
    expect(kinds(await getBanners())).not.toContain("no_model_key");
  });

  it("shows model_paused with the reason and the time in the feed's time zone", async () => {
    beat(1000);
    const feed = makeFeed({ digest: { frequency: "daily", weekday: 1, time: "08:00", timeZone: "Europe/Berlin", maxStories: 10 } });
    setLlmPause({ until: NOW + 30 * MINUTE_MS, step: 1, lastError: "the service is busy" });
    const utc = (await getBanners()).find((b) => b.kind === "model_paused");
    expect(utc?.message).toMatch(/^The model is not available now \(the service is busy\)\. Judging starts again at \d\d:\d\d\.$/);
    const berlin = (await getBanners(feed.id)).find((b) => b.kind === "model_paused");
    expect(berlin?.message).toBe("The model is not available now (the service is busy). Judging starts again at 13:30.");
  });

  it("adds the date when the pause ends on another day", async () => {
    beat(1000);
    const feed = makeFeed();
    setLlmPause({ until: NOW + 20 * HOUR_MS, step: 1, lastError: "no credits" });
    const banner = (await getBanners(feed.id)).find((b) => b.kind === "model_paused");
    expect(banner?.message).toBe("The model is not available now (no credits). Judging starts again at 08:00 on 21 Nov.");
  });

  it("shows no model banner when the pause is over", async () => {
    beat(1000);
    setLlmPause({ until: NOW - MINUTE_MS, step: 1, lastError: "old" });
    expect(kinds(await getBanners())).toEqual([]);
  });

  it("shows budget_used when the daily call limit is used, instead of the pause", async () => {
    beat(1000);
    vi.stubEnv("LLM_MAX_CALLS_PER_DAY", "5");
    use("llm_calls", 4);
    expect(kinds(await getBanners())).not.toContain("budget_used");
    use("llm_calls", 1);
    setLlmPause({ until: NOW + 12 * HOUR_MS, step: 0, lastError: "The daily limit is used" });
    const banners = await getBanners();
    expect(kinds(banners)).toEqual(["budget_used"]);
    expect(banners[0]?.message).toBe("The model call limit for today is used (5 of 5). Judging starts again tomorrow (UTC).");
  });

  it("shows no pause or budget banner when the key is missing", async () => {
    beat(1000, { model: false });
    setLlmPause({ until: NOW + MINUTE_MS, step: 1, lastError: "x" });
    expect(kinds(await getBanners())).toEqual(["no_model_key"]);
  });

  it("shows first_run while the feed has sources, no judgement, and a source waits for its first check", async () => {
    beat(1000);
    const empty = makeFeed();
    expect(kinds(await getBanners(empty.id))).toEqual([]);

    const { feed, source } = feedWithSource();
    const banners = await getBanners(feed.id);
    expect(kinds(banners)).toEqual(["first_run"]);
    expect(banners[0]?.message).toBe("The first checks run now. Stories show here in a few minutes.");

    getSqlite().prepare("UPDATE sources SET last_checked_at = ? WHERE id = ?").run(NOW, source.id);
    expect(kinds(await getBanners(feed.id))).toEqual([]);

    getSqlite().prepare("UPDATE sources SET last_checked_at = NULL WHERE id = ?").run(source.id);
    judgedStory(feed.id, source.id);
    expect(kinds(await getBanners(feed.id))).toEqual([]);
  });

  it("shows no first_run when every never-checked source needs a missing credential (as the worker sees it)", async () => {
    beat(1000, { x: false });
    const feed = makeFeed();
    const x = makeSource({ type: "x_user", name: "@sama" });
    linkFeedSource(feed.id, x.id);
    expect(kinds(await getBanners(feed.id))).not.toContain("first_run");

    beat(1000, { x: true });
    expect(kinds(await getBanners(feed.id))).toContain("first_run");

    beat(1000, { x: false });
    const blog = makeSource();
    linkFeedSource(feed.id, blog.id);
    expect(kinds(await getBanners(feed.id))).toContain("first_run");
  });

  it("shows source_errors for an unpaused source of the feed with a failed last check or a missing credential", async () => {
    beat(1000, { x: false });
    const feed = makeFeed();
    const ok = makeSource({ name: "Fine", lastCheckedAt: NOW });
    linkFeedSource(feed.id, ok.id);
    expect(kinds(await getBanners(feed.id))).toEqual([]);

    const broken = makeSource({ name: "Broken blog", lastCheckedAt: NOW, consecutiveFailures: 1, lastError: "HTTP 404. The page is gone." });
    linkFeedSource(feed.id, broken.id);
    const one = (await getBanners(feed.id)).find((b) => b.kind === "source_errors");
    expect(one).toEqual({
      kind: "source_errors",
      tone: "warning",
      message: "1 source of this feed has a problem: Broken blog: the last check failed (HTTP 404).",
      link: { href: `/sources/${broken.id}`, label: "Open the source" },
    });
    expect(kinds(await getBanners())).not.toContain("source_errors");

    const x = makeSource({ type: "x_user", name: "@sama", lastCheckedAt: NOW });
    linkFeedSource(feed.id, x.id);
    const paused = makeSource({ name: "Paused", paused: true, lastCheckedAt: NOW, lastError: "500" });
    linkFeedSource(feed.id, paused.id);
    const elsewhere = makeSource({ name: "Other feed", lastCheckedAt: NOW, lastError: "500" });
    linkFeedSource(makeFeed().id, elsewhere.id);
    const two = (await getBanners(feed.id)).find((b) => b.kind === "source_errors");
    expect(two?.message).toBe(
      "2 sources of this feed have a problem: Broken blog: the last check failed (HTTP 404); @sama: needs an X API token.",
    );
    expect(two?.link).toEqual({ href: `/sources?feed=${feed.id}`, label: "Open the sources" });

    const third = makeSource({ name: "Zed", lastCheckedAt: NOW, consecutiveFailures: 4, lastError: "timeout" });
    linkFeedSource(feed.id, third.id);
    const three = (await getBanners(feed.id)).find((b) => b.kind === "source_errors");
    expect(three?.message).toBe(
      "3 sources of this feed have a problem: Zed: the last check failed (timeout); Broken blog: the last check failed (HTTP 404); and 1 more.",
    );
  });
});

describe("retryFailedItems", () => {
  it("sets failed items back to pending with attempts 0 and writes the activity log", async () => {
    const source = makeSource();
    const failed = makeItem({ sourceId: source.id, judgeStatus: "failed", judgeAttempts: 5, judgeError: "bad output", nextJudgeAt: NOW + HOUR_MS });
    makeItem({ sourceId: source.id, judgeStatus: "failed" });
    const skipped = makeItem({ sourceId: source.id, judgeStatus: "skipped", skipReason: "too_old" });

    expect(await retryFailedItems({ name: "Dana", clientId: "c1" })).toBe(2);
    const row = getSqlite()
      .prepare("SELECT judge_status AS s, judge_attempts AS a, judge_error AS e, next_judge_at AS n FROM items WHERE id = ?")
      .get(failed.id);
    expect(row).toEqual({ s: "pending", a: 0, e: null, n: null });
    expect((getSqlite().prepare("SELECT judge_status AS s FROM items WHERE id = ?").get(skipped.id) as { s: string }).s).toBe("skipped");
    const activity = getSqlite().prepare("SELECT actor, action FROM activity").all();
    expect(activity).toEqual([{ actor: "Dana", action: "retry_failed_items" }]);
    expect(await retryFailedItems({ name: "Dana", clientId: "c1" })).toBe(0);
  });

  it("needs a display name", async () => {
    await expect(retryFailedItems({ name: "", clientId: "c1" })).rejects.toMatchObject({ code: "needs_name" });
    await expect(retryFailedItems({ name: "Someone", clientId: "c1" })).rejects.toMatchObject({ code: "needs_name" });
  });
});
