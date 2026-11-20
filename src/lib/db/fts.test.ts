import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { events } from "@/lib/db/schema";
import { installTestDb, makeStory, type InstalledTestDb } from "@/test/helpers";

import { buildMatchText, deleteStoryFts, searchStories, upsertStoryFts } from "./fts";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  t.cleanup();
});

describe("buildMatchText", () => {
  it("puts each word in double quotes and joins the words with OR", () => {
    expect(buildMatchText(["claude", "code", "agents"])).toBe('"claude" OR "code" OR "agents"');
  });

  it("removes inner quotes, drops empty words, and takes at most 12 words", () => {
    expect(buildMatchText(['say "hi"', '"', "  ", "ok"])).toBe('"say hi" OR "ok"');
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`);
    expect(buildMatchText(many).split(" OR ")).toHaveLength(12);
    expect(buildMatchText([])).toBe("");
  });
});

describe("stories_fts", () => {
  it("finds a story by its headline, its summary, and its entities, best match first", () => {
    const a = makeStory({
      headline: "Claude Code adds background agents",
      summary: ["The release adds agents that run in the background.", "A new permission mode comes with it."],
      entities: ["Claude Code", "Anthropic"],
      lastItemAt: 1000,
    });
    const b = makeStory({
      headline: "Foundry deprecates the classic agents API",
      summary: ["Microsoft Foundry removes the classic API in March."],
      entities: ["Microsoft Foundry"],
      lastItemAt: 2000,
    });

    expect(searchStories(buildMatchText(["anthropic"]), 0, 5).map((row) => row.id)).toEqual([a.id]);
    expect(searchStories(buildMatchText(["deprecates"]), 0, 5).map((row) => row.id)).toEqual([b.id]);
    // The porter tokenizer matches "permissions" with "permission".
    expect(searchStories(buildMatchText(["permissions"]), 0, 5).map((row) => row.id)).toEqual([a.id]);

    const both = searchStories(buildMatchText(["agents", "background", "claude"]), 0, 5);
    expect(both.map((row) => row.id)).toEqual([a.id, b.id]);
    expect(both[0]!.rank).toBeLessThan(both[1]!.rank);

    // The filter on last_item_at and the limit.
    expect(searchStories(buildMatchText(["agents"]), 1500, 5).map((row) => row.id)).toEqual([b.id]);
    expect(searchStories(buildMatchText(["agents"]), 0, 1)).toHaveLength(1);
    expect(searchStories(buildMatchText(["nothing"]), 0, 5)).toEqual([]);
  });

  it("replaces the row on upsert and removes it on delete", () => {
    const story = makeStory({ headline: "First headline", summary: ["Old text."], entities: [] });
    upsertStoryFts(story.id, "Second headline", ["New text about turbines."], ["Acme"]);
    expect(searchStories('"first"', 0, 5)).toEqual([]);
    expect(searchStories('"turbines"', 0, 5).map((row) => row.id)).toEqual([story.id]);
    expect(t.sqlite.prepare("SELECT count(*) FROM stories_fts").pluck().get()).toBe(1);

    deleteStoryFts(story.id);
    deleteStoryFts(story.id);
    expect(searchStories('"second"', 0, 5)).toEqual([]);
    expect(t.sqlite.prepare("SELECT count(*) FROM stories_fts").pluck().get()).toBe(0);
  });

  it("returns [] for an empty text and for an FTS syntax error (with a warn event), and does not throw", () => {
    makeStory({ headline: "Something" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(searchStories("", 0, 5)).toEqual([]);
    expect(searchStories("   ", 0, 5)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    expect(searchStories('"unclosed AND (', 0, 5)).toEqual([]);
    expect(searchStories("NEAR(", 0, 5)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    const rows = t.db.select().from(events).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ level: "warn", scope: "fts" });
  });
});
