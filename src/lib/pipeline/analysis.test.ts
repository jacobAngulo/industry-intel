import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LlmError } from "@/lib/llm/types";
import { MINUTE_MS } from "@/lib/time";
import {
  FakeHttp,
  FakeLlm,
  installTestDb,
  makeFeed,
  makeItem,
  makeSource,
  makeStory,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { analysisReply } from "./__fixtures__/replies";
import { runNextAnalysis } from "./analysis";
import { readLlmPause } from "./jobs";
import type { PipelineDeps } from "./types";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const PRIMARY = "https://blog.example.com/networking";
const SECOND = "https://news.example.com/report";
const ARTICLE = `<html><head><title>Networking</title></head><body><article><h1>Private networking</h1>
<p>Private networking for tool calls is now in preview for all regions. The feature uses private endpoints.</p>
<p>Teams can turn it on for each project. It needs the new SDK version 2.1.</p></article></body></html>`;

let t: InstalledTestDb;
let llm: FakeLlm;
let http: FakeHttp;
let deps: PipelineDeps;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
  llm = new FakeLlm();
  http = new FakeHttp();
  deps = { llm, http, search: null, mail: null, now: () => NOW };
});

afterEach(() => {
  t.cleanup();
});

type AnalysisRow = { status: string; stage: string | null; content: string | null; error: string | null; model: string | null; attempts: number; started_at: number | null; finished_at: number | null };
const analysisRow = (id: number) => t.sqlite.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as AnalysisRow;

function queue(feedOver: Parameters<typeof makeFeed>[0] = {}, meta: Record<string, unknown> = {}) {
  const feed = makeFeed({ name: "Internal AI Platform", ...feedOver });
  const source = makeSource({ name: "Foundry blog" });
  const story = makeStory({ headline: "Private networking for tools", primaryUrl: PRIMARY });
  makeItem({ sourceId: source.id, storyId: story.id, url: PRIMARY, contentText: "Stored text of the post.", meta });
  makeItem({ sourceId: makeSource({ name: "News site" }).id, storyId: story.id, url: SECOND, contentText: "Stored report text." });
  const row = t.sqlite
    .prepare(
      `INSERT INTO analyses (feed_id, story_id, status, requested_by, requested_at, updated_at)
       VALUES (?, ?, 'queued', 'Ana', ?, ?) RETURNING id`,
    )
    .get(feed.id, story.id, NOW - 1000, NOW - 1000) as { id: number };
  return { feed, story, id: row.id };
}

describe("runNextAnalysis", () => {
  it("returns false when nothing is queued", async () => {
    expect(await runNextAnalysis(deps)).toBe(false);
  });

  it("reads the sources, writes the analysis, keeps only allowed URLs, and stores the model", async () => {
    const { id } = queue();
    http.on(PRIMARY, { text: ARTICLE, headers: { "content-type": "text/html" } });
    http.on(SECOND, { status: 500 });
    let stageDuringCall: string | null = null;
    llm.enqueue(() => {
      stageDuringCall = analysisRow(id).stage;
      return analysisReply({ sources_used: [PRIMARY, "https://evil.example.com/x", `${SECOND}/`] });
    });

    expect(await runNextAnalysis(deps)).toBe(true);
    expect(stageDuringCall).toBe("Writing");
    const row = analysisRow(id);
    expect(row).toMatchObject({ status: "done", stage: null, error: null, model: "fake-analysis", started_at: NOW, finished_at: NOW });
    const content = JSON.parse(row.content ?? "{}");
    expect(content.sourcesUsed).toEqual([PRIMARY, SECOND]);
    expect(content.suggestedActions).toHaveLength(1);
    expect(content.suggestedActions[0]).toMatchObject({ firstStep: "Create the endpoint." });

    const call = llm.calls[0];
    expect(call?.task).toBe("analysis");
    expect(call?.user).toContain("needs the new SDK version 2.1");
    expect(call?.user).toContain("Stored report text."); // the failed fetch keeps the stored text
    expect(call?.user).toContain(`- ${PRIMARY}`);
    expect(call?.user).toContain("Suggested actions: on");
    expect(call?.user).toContain("<<<SOURCES");
    expect(http.urls).toEqual([PRIMARY, SECOND]);
  });

  it("empties the actions when the feed has suggested actions off", async () => {
    const { id } = queue({ briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: false } });
    llm.enqueue(analysisReply());
    await runNextAnalysis(deps);
    expect(JSON.parse(analysisRow(id).content ?? "{}").suggestedActions).toEqual([]);
    expect(llm.calls[0]?.user).toContain("Suggested actions: off");
  });

  it("tells the model when only the show notes of an episode were available", async () => {
    queue({}, { basis: "show_notes" });
    llm.enqueue(analysisReply());
    await runNextAnalysis(deps);
    expect(llm.calls[0]?.user).toContain("Basis: show_notes");
    expect(llm.calls[0]?.system).toContain("only the show notes of the episode were available");
  });

  it("an item error counts an attempt and queues again; the third attempt fails", async () => {
    const { id } = queue();
    llm.enqueue(new LlmError("bad_output", "The reply was not valid."));
    await runNextAnalysis(deps);
    expect(analysisRow(id)).toMatchObject({ status: "queued", attempts: 1, error: "The reply was not valid.", stage: null });
    llm.enqueue(new LlmError("bad_output", "bad"), new LlmError("timeout", "slow"));
    await runNextAnalysis(deps);
    await runNextAnalysis(deps);
    expect(analysisRow(id)).toMatchObject({ status: "failed", attempts: 3, error: "slow", finished_at: NOW });
    expect(readLlmPause().pausedUntil).toBe(NOW + 2 * MINUTE_MS);
  });

  it("a service error leaves the row queued with no attempt and pauses the model", async () => {
    const { id } = queue();
    llm.enqueue(new LlmError("overloaded", "busy"));
    expect(await runNextAnalysis(deps)).toBe(true);
    expect(analysisRow(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(readLlmPause().pausedUntil).toBe(NOW + 2 * MINUTE_MS);
  });

  it("takes the oldest queued row first", async () => {
    const first = queue();
    const second = queue();
    t.sqlite.prepare("UPDATE analyses SET requested_at = ? WHERE id = ?").run(NOW - 5000, second.id);
    llm.enqueue(analysisReply());
    await runNextAnalysis(deps);
    expect(analysisRow(second.id).status).toBe("done");
    expect(analysisRow(first.id).status).toBe("queued");
  });
});
