import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectors } from "@/lib/connectors/registry";
import { ConnectorError, type Candidate, type RawItem } from "@/lib/connectors/types";
import { PAGE_PREVIEW_NOTE } from "@/lib/connectors/docs";
import { WEB_SEARCH_PREVIEW_NOTE } from "@/lib/connectors/web_search";
import { activity, feedSources, sources } from "@/lib/db/schema";
import { setDepsForTests, type Deps } from "@/lib/deps";
import { LlmError } from "@/lib/llm/types";
import { judgeDraft } from "@/lib/pipeline";
import { setLlmPause } from "@/lib/pipeline/jobs";
import { MINUTE_MS, nowMs } from "@/lib/time";
import { SOURCE_TYPES, type SourceType } from "@/lib/types";
import {
  FakeHttp,
  FakeLlm,
  FakeUsageMeter,
  installTestDb,
  makeEnv,
  makeFeed,
  makeSource,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { ServiceError } from "./_manage-errors";
import {
  createFromWizard,
  previewSource,
  qualifyPreview,
  resetPreviewLimitForTests,
  resolveEntries,
} from "./add-source";
import type { PreviewItem, WizardCreate } from "./types";

// judgeDraft belongs to the pipeline agent: the tests replace it.
vi.mock("@/lib/pipeline", () => ({ judgeDraft: vi.fn() }));

const NOW = 1_800_000_000_000;
const actor = { name: "Dana", userId: "c1" };

let t: InstalledTestDb;
let usage: FakeUsageMeter;

function installDeps(env: Record<string, string> = {}): Deps {
  usage = new FakeUsageMeter({ llm_calls_preview: 100 });
  const deps: Deps = {
    env: makeEnv(env),
    http: new FakeHttp(),
    usage,
    llm: new FakeLlm(),
    search: null,
    mail: null,
    now: nowMs,
  };
  setDepsForTests(deps);
  return deps;
}

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
  installDeps();
  resetPreviewLimitForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(judgeDraft).mockReset();
  setDepsForTests(null);
  t.cleanup();
});

async function expectCode(promise: Promise<unknown>, code: ServiceError["code"]): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

function candidate(type: SourceType, config: unknown, confidence = 0.9): Candidate {
  return { type, name: `${type} candidate`, description: "One line.", config, confidence };
}

/** Every connector resolves to nothing, except the ones that a test sets. */
function silenceResolvers() {
  for (const type of SOURCE_TYPES) vi.spyOn(connectors[type], "resolve").mockResolvedValue([]);
}

describe("resolveEntries", () => {
  it("resolves with the forced type and marks an entry whose key exists", async () => {
    const existing = makeSource({ type: "x_user", config: { username: "chamath" }, name: "@chamath" });
    const entries = await resolveEntries(["@chamath", " x.com/naval ", ""], "x_user");
    expect(entries.map((entry) => entry.input)).toEqual(["@chamath", "x.com/naval"]);
    expect(entries[0]?.candidates[0]).toMatchObject({ type: "x_user", config: { username: "chamath" } });
    expect(entries[0]?.existing).toEqual({ id: existing.id, name: "@chamath" });
    expect(entries[1]?.existing).toBeNull();
    expect(entries[1]?.candidates[0]).toMatchObject({ type: "x_user" });
  });

  it("merges the candidates of all types and says when an entry did not resolve", async () => {
    silenceResolvers();
    vi.spyOn(connectors.blog, "resolve").mockImplementation(async (input) =>
      input.includes("example") ? [candidate("blog", { feedUrl: "https://example.com/feed.xml" }, 0.6)] : [],
    );
    vi.spyOn(connectors.docs, "resolve").mockImplementation(async (input) =>
      input.includes("example") ? [candidate("docs", { url: "https://example.com/" }, 0.4)] : [],
    );
    const known = makeSource({ type: "docs", config: { url: "https://example.com/" }, name: "Example docs" });

    const [found, none] = await resolveEntries(["https://example.com/", "nothing here"]);
    expect(found?.candidates.map((c) => c.type)).toEqual(["blog", "docs"]);
    expect(found?.existing).toEqual({ id: known.id, name: "Example docs" });
    expect(found?.error).toBeUndefined();
    expect(none?.candidates).toEqual([]);
    expect(none?.error).toMatch(/No source was found/);
  });

  it("passes the connector context of getDeps to the connectors", async () => {
    silenceResolvers();
    const deps = installDeps();
    const spy = vi.spyOn(connectors.github, "resolve").mockResolvedValue([]);
    await resolveEntries(["anthropics/claude-code"], "github");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1].http).toBe(deps.http);
    expect(spy.mock.calls[0]?.[2]).toBe(true);
  });

  it("takes at most 10 entries and at least one", async () => {
    await expectCode(resolveEntries(Array.from({ length: 11 }, (_, i) => `@user${i}`), "x_user"), "validation");
    await expectCode(resolveEntries(["  ", ""]), "validation");
    await expectCode(resolveEntries(["@a"], "nope" as SourceType), "validation");
  });
});

function rawItems(n: number, extra: Partial<RawItem> = {}): RawItem[] {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `e${i}`,
    title: `Title ${i}`,
    url: `https://example.com/${i}`,
    publishedAt: NOW - i * MINUTE_MS,
    kind: "article",
    text: `Text   ${i}\n${"word ".repeat(200)}`,
    ...extra,
  }));
}

const blogEntry = (n: number) => ({ type: "blog" as const, name: `Blog ${n}`, config: { feedUrl: `https://example.com/${n}.xml` } });

describe("previewSource", () => {
  it("fetches in preview mode with no database write: 10 items for one entry", async () => {
    const fetch = vi.spyOn(connectors.blog, "fetch").mockResolvedValue({ items: rawItems(12), cursor: { etag: "x" } });
    const result = await previewSource([blogEntry(1)]);

    expect(fetch.mock.calls[0]?.[0]).toMatchObject({ mode: "preview", limit: 10, cursor: null });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.items).toHaveLength(10);
    expect(result.entries[0]?.items[0]).toMatchObject({ externalId: "e0", title: "Title 0", url: "https://example.com/0", publishedAt: NOW });
    expect(result.entries[0]?.items[0]?.excerpt.startsWith("Text 0 word")).toBe(true);
    expect(result.entries[0]?.items[0]?.excerpt.length).toBeLessThanOrEqual(500);
    expect(t.db.select().from(sources).all()).toEqual([]);
  });

  it("asks for 3 items each for several entries", async () => {
    const fetch = vi.spyOn(connectors.blog, "fetch").mockResolvedValue({ items: rawItems(3), cursor: null });
    const result = await previewSource([blogEntry(1), blogEntry(2)]);
    expect(fetch.mock.calls.map((call) => call[0].limit)).toEqual([3, 3]);
    expect(result.entries.map((entry) => entry.name)).toEqual(["Blog 1", "Blog 2"]);
  });

  it("allows at most 10 previews each minute for the process", async () => {
    vi.spyOn(connectors.blog, "fetch").mockResolvedValue({ items: [], cursor: null });
    await previewSource(Array.from({ length: 8 }, (_, i) => blogEntry(i)));
    await previewSource([blogEntry(8), blogEntry(9)]);
    await expectCode(previewSource([blogEntry(10)]), "limit");
    setNowForTests(NOW + MINUTE_MS + 1);
    await expect(previewSource([blogEntry(10)])).resolves.toBeDefined();
  });

  it("adds the notes of the docs page watch and of the web search", async () => {
    vi.spyOn(connectors.docs, "fetch").mockResolvedValue({ items: rawItems(2, { kind: "doc_change", meta: { sample: true } }), cursor: null });
    vi.spyOn(connectors.web_search, "fetch").mockResolvedValue({ items: rawItems(1, { kind: "search_result" }), cursor: null });
    vi.spyOn(connectors.blog, "fetch").mockResolvedValue({ items: rawItems(1), cursor: null });
    installDeps({ OLLAMA_API_KEY: "test-key" });
    const result = await previewSource([
      { type: "docs", name: "Docs", config: { url: "https://example.com/whats-new" } },
      { type: "web_search", name: "Search", config: { query: "agent evals" } },
      blogEntry(1),
    ]);
    expect(result.entries.map((entry) => entry.note)).toEqual([PAGE_PREVIEW_NOTE, WEB_SEARCH_PREVIEW_NOTE, undefined]);
  });

  it("shows errors as plain messages, and a missing credential without a fetch", async () => {
    vi.spyOn(connectors.blog, "fetch")
      .mockRejectedValueOnce(new ConnectorError("not_found", "The feed address returned 404."))
      .mockRejectedValueOnce(new Error("secret internal detail"));
    const xFetch = vi.spyOn(connectors.x_user, "fetch");
    const result = await previewSource([
      blogEntry(1),
      blogEntry(2),
      { type: "x_user", name: "@a", config: { username: "a" } },
      { type: "github", name: "Bad", config: { owner: "" } },
    ]);
    expect(result.entries.map((entry) => entry.error)).toEqual([
      "The feed address returned 404.",
      "The preview failed. Try again later.",
      expect.stringContaining("X_BEARER_TOKEN"),
      "The settings of this source are not valid.",
    ]);
    expect(xFetch).not.toHaveBeenCalled();
  });
});

function previewItems(n: number): PreviewItem[] {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `p${i}`,
    title: `Item ${i}`,
    url: `https://example.com/p${i}`,
    // p0 is the oldest; p(n-1) the newest; one item has no date.
    publishedAt: i === 1 ? null : NOW - (n - i) * MINUTE_MS,
    excerpt: `Excerpt ${i}`,
  }));
}

const qualifyArgs = (feedIds: number[], items = previewItems(3)) => ({
  type: "blog" as const,
  sourceName: "Example blog",
  items,
  config: { feedUrl: "https://example.com/feed.xml" },
  feedIds,
  follow: "agents",
  ignore: "hiring",
  priority: "high" as const,
});

describe("qualifyPreview", () => {
  it("is not available when the model gate is closed (no key)", async () => {
    const feed = makeFeed();
    const result = await qualifyPreview(qualifyArgs([feed.id]));
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toMatch(/model key is missing/);
    expect(judgeDraft).not.toHaveBeenCalled();
  });

  it("is not available while the model is paused, or when the preview limit is used", async () => {
    installDeps({ OLLAMA_API_KEY: "test-key" });
    const feed = makeFeed();
    setLlmPause({ until: Date.UTC(2027, 0, 15, 12, 30), step: 1, lastError: "The model service is overloaded" }, NOW);
    const paused = await qualifyPreview(qualifyArgs([feed.id]));
    expect(paused.unavailableReason).toBe(
      "The model is not available now (The model service is overloaded). It starts again at 15 Jan 2027, 12:30 UTC. You can still add the source.",
    );

    setLlmPause({ until: NOW - 1, step: 0, lastError: "" }, NOW);
    usage.limits.llm_calls_preview = 0;
    const used = await qualifyPreview(qualifyArgs([feed.id]));
    expect(used.unavailableReason).toMatch(/limit of preview checks/);
    expect(judgeDraft).not.toHaveBeenCalled();
  });

  it("needs at least one active feed", async () => {
    installDeps({ OLLAMA_API_KEY: "test-key" });
    const archived = makeFeed({ archivedAt: NOW });
    expect((await qualifyPreview(qualifyArgs([]))).unavailableReason).toMatch(/Select at least one feed/);
    expect((await qualifyPreview(qualifyArgs([archived.id]))).available).toBe(false);
  });

  it("judges at most 5 of the newest items and counts those that would enter each feed", async () => {
    const deps = installDeps({ OLLAMA_API_KEY: "test-key" });
    const a = makeFeed({ name: "Agentic Development" });
    const b = makeFeed({ name: "Radar" });
    vi.mocked(judgeDraft).mockImplementation(async ({ item, feeds }) =>
      feeds.map((feed) => {
        const enters = feed.feedId === a.id && item.externalId !== "p6";
        return { feedId: feed.feedId, relevance: enters ? 80 : 40, reason: `Reason ${item.externalId}`, whyItMatters: "", hiddenReason: enters ? null : "below_threshold" };
      }),
    );

    const result = await qualifyPreview(qualifyArgs([a.id, b.id], previewItems(7)));

    expect(judgeDraft).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(judgeDraft).mock.calls.map((call) => call[0]);
    expect(calls.map((call) => call.item.externalId)).toEqual(["p6", "p5", "p4", "p3", "p2"]);
    expect(calls[0]).toMatchObject({
      item: { kind: "article", title: "Item 6", text: "Excerpt 6", url: "https://example.com/p6" },
      source: { name: "Example blog", type: "blog" },
      feeds: [
        { feedId: a.id, follow: "agents", ignore: "hiring", priority: "high" },
        { feedId: b.id, follow: "agents", ignore: "hiring", priority: "high" },
      ],
    });
    expect(calls[0]?.deps).toBe(deps);

    expect(result.available).toBe(true);
    expect(result.perFeed.map((feed) => [feed.feedName, feed.wouldEnter, feed.total])).toEqual([
      ["Agentic Development", 4, 5],
      ["Radar", 0, 5],
    ]);
    expect(result.perFeed[0]?.items[0]).toEqual({
      externalId: "p6",
      title: "Item 6",
      relevance: 40,
      reason: "Reason p6",
      wouldEnter: false,
      hidden: "below_threshold",
    });
  });

  it("keeps the items judged before a model error; with none, it says why", async () => {
    installDeps({ OLLAMA_API_KEY: "test-key" });
    const feed = makeFeed();
    vi.mocked(judgeDraft)
      .mockResolvedValueOnce([{ feedId: feed.id, relevance: 90, reason: "r", whyItMatters: "w", hiddenReason: null }])
      .mockRejectedValueOnce(new LlmError("overloaded", "The model service is busy."));
    const partial = await qualifyPreview(qualifyArgs([feed.id]));
    expect(partial.available).toBe(true);
    expect(partial.perFeed[0]).toMatchObject({ wouldEnter: 1, total: 1 });

    vi.mocked(judgeDraft).mockRejectedValueOnce(new LlmError("budget", "The preview limit is used."));
    const none = await qualifyPreview(qualifyArgs([feed.id]));
    expect(none).toEqual({ available: false, unavailableReason: "The preview limit is used. You can still add the source.", perFeed: [] });
  });
});

const wizard = (entries: WizardCreate["entries"], common: Partial<WizardCreate["common"]> = {}): WizardCreate => ({
  entries,
  common: {
    why: "Releases of tools that we use.",
    feedIds: [],
    follow: "",
    ignore: "",
    priority: "normal",
    checkIntervalMinutes: 120,
    owner: "Dana",
    ...common,
  },
});

describe("createFromWizard", () => {
  it("creates several sources with feed links and the first check; skips an existing key and a duplicate", async () => {
    const a = makeFeed();
    const b = makeFeed();
    const existing = makeSource({ type: "github", config: { owner: "openai", repo: "codex" }, name: "Codex" });

    const result = await createFromWizard(
      wizard(
        [
          { type: "github", name: "Claude Code", url: "https://github.com/anthropics/claude-code", config: { owner: "anthropics", repo: "claude-code" } },
          { type: "github", name: "Codex again", config: { owner: "OpenAI", repo: "Codex" } },
          { type: "github", name: "Gemini CLI", config: { owner: "google-gemini", repo: "gemini-cli" } },
          { type: "github", name: "Claude Code twice", config: { owner: "anthropics", repo: "CLAUDE-CODE" } },
        ],
        { feedIds: [a.id, b.id, a.id], follow: "agents", ignore: "docs typos", priority: "high", owner: "" },
      ),
      actor,
    );

    expect(result.created.map((row) => row.name)).toEqual(["Claude Code", "Gemini CLI"]);
    expect(result.skipped).toEqual([
      { name: "Codex again", reason: `Already in the directory as "${existing.name}".` },
      { name: "Claude Code twice", reason: "The same source is twice in the list." },
    ]);
    expect(result.queuedStories).toBe(0);

    const created = t.db.select().from(sources).all().filter((row) => row.id !== existing.id);
    expect(created[0]).toMatchObject({
      type: "github",
      key: "github:anthropics/claude-code",
      url: "https://github.com/anthropics/claude-code",
      why: "Releases of tools that we use.",
      addedBy: "Dana",
      owner: null,
      checkIntervalMinutes: 120,
      checkRequestedAt: NOW,
      nextCheckAt: NOW,
      config: { owner: "anthropics", repo: "claude-code", releases: true, prereleases: false },
    });
    const links = t.db.select().from(feedSources).all();
    expect(links).toHaveLength(4);
    expect(links.every((link) => link.priority === "high" && link.follow === "agents" && link.ignore === "docs typos")).toBe(true);
    expect(t.db.select().from(activity).all().map((row) => [row.action, row.entityId])).toEqual(
      result.created.map((row) => ["source.create", row.id]),
    );
  });

  it("validates each config again with the schema of its type", async () => {
    const error = await expectCode(
      createFromWizard(
        wizard([
          { type: "github", name: "Fine", config: { owner: "a", repo: "b" } },
          { type: "github", name: "Broken", config: { owner: "bad owner!", repo: "b" } },
        ]),
        actor,
      ),
      "validation",
    );
    expect(error.fieldErrors).toHaveProperty("entries.1.config.owner");
    expect(t.db.select().from(sources).all()).toEqual([]);
  });

  it("rejects an unknown or archived feed, a missing why, and too many entries", async () => {
    const archived = makeFeed({ archivedAt: NOW });
    const entry = { type: "github" as const, name: "A", config: { owner: "a", repo: "b" } };
    await expectCode(createFromWizard(wizard([entry], { feedIds: [archived.id] }), actor), "validation");
    await expectCode(createFromWizard(wizard([entry], { feedIds: [999] }), actor), "validation");
    await expectCode(createFromWizard(wizard([entry], { why: " " }), actor), "validation");
    await expectCode(createFromWizard(wizard(Array.from({ length: 11 }, () => entry)), actor), "validation");
    expect(t.db.select().from(sources).all()).toEqual([]);
  });

  it("stops at 500 sources (§14)", async () => {
    const insert = t.sqlite.prepare(
      `INSERT INTO sources (type, key, name, config, check_interval_minutes, created_at, updated_at) VALUES ('blog', ?, 'S', '{}', 60, 0, 0)`,
    );
    for (let i = 0; i < 499; i += 1) insert.run(`blog:https://example.com/${i}`);
    const entry = (n: number) => ({ type: "github" as const, name: `R${n}`, config: { owner: "a", repo: `r${n}` } });
    await expectCode(createFromWizard(wizard([entry(1), entry(2)]), actor), "limit");
    const ok = await createFromWizard(wizard([entry(1)]), actor);
    expect(ok.created).toHaveLength(1);
  });
});
