import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MINUTE_MS } from "@/lib/time";
import { installTestDb, makeItem, makeSource, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { claimItemsToJudge } from "./claim";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;
let sourceId: number;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
  sourceId = makeSource().id;
});

afterEach(() => {
  t.cleanup();
});

function lockOf(id: number): number | null {
  return (t.sqlite.prepare("SELECT judge_locked_until AS lock FROM items WHERE id = ?").get(id) as { lock: number | null }).lock;
}

describe("claimItemsToJudge", () => {
  it("claims due, unlocked, pending items, oldest fetched first, and locks them for 3 minutes", () => {
    const newer = makeItem({ sourceId, fetchedAt: NOW - 1000, title: "Alpha release notes" });
    const older = makeItem({ sourceId, fetchedAt: NOW - 5000, title: "Bravo security fix" });
    makeItem({ sourceId, judgeStatus: "judged", title: "Charlie" });
    makeItem({ sourceId, nextJudgeAt: NOW + MINUTE_MS, title: "Delta" });
    makeItem({ sourceId, judgeLockedUntil: NOW + MINUTE_MS, title: "Echo" });
    const retryDue = makeItem({ sourceId, nextJudgeAt: NOW, fetchedAt: NOW - 100, title: "Foxtrot" });
    expect(claimItemsToJudge(10, [], NOW)).toEqual([older.id, newer.id, retryDue.id]);
    expect(lockOf(older.id)).toBe(NOW + 3 * MINUTE_MS);
    // A second claim finds them locked.
    expect(claimItemsToJudge(10, [], NOW)).toEqual([]);
  });

  it("respects the limit", () => {
    makeItem({ sourceId, title: "One topic" });
    makeItem({ sourceId, title: "Another subject" });
    expect(claimItemsToJudge(1, [], NOW)).toHaveLength(1);
  });

  it("skips an item with the same canonical URL as an in-flight item", () => {
    const busy = makeItem({ sourceId, url: "https://example.com/a", title: "First" });
    const same = makeItem({ sourceId: makeSource().id, url: "https://example.com/a", title: "Second" });
    expect(claimItemsToJudge(5, [busy.id], NOW)).not.toContain(same.id);
  });

  it("skips an item with a link relation in either direction", () => {
    const busy = makeItem({ sourceId, url: "https://example.com/a", title: "Launch post", links: ["https://example.com/b"] });
    const linksToBusy = makeItem({ sourceId, url: "https://hn.example.com/1", title: "Discussion one", links: ["https://example.com/a"] });
    const linkedByBusy = makeItem({ sourceId, url: "https://example.com/b", title: "Referenced page" });
    const free = makeItem({ sourceId, url: "https://example.com/c", title: "Unrelated item" });
    expect(claimItemsToJudge(5, [busy.id], NOW)).toEqual([free.id]);
    expect(linksToBusy.id).toBeGreaterThan(0);
    expect(linkedByBusy.id).toBeGreaterThan(0);
  });

  it("skips an item with at least half of the significant title words in common (minimum 2)", () => {
    const busy = makeItem({ sourceId, title: "Copilot CLI adds MCP allow lists" });
    const similar = makeItem({ sourceId, title: "GitHub Copilot CLI: MCP allow lists arrive" });
    const oneWord = makeItem({ sourceId, title: "Copilot pricing update" });
    expect(claimItemsToJudge(5, [busy.id], NOW)).toEqual([oneWord.id]);
    expect(similar.id).toBeGreaterThan(0);
  });

  it("does not claim two related items in the same call", () => {
    const first = makeItem({ sourceId, url: "https://example.com/a", title: "Alpha", fetchedAt: NOW - 10 });
    makeItem({ sourceId: makeSource().id, url: "https://example.com/a", title: "Beta", fetchedAt: NOW - 5 });
    expect(claimItemsToJudge(5, [], NOW)).toEqual([first.id]);
  });

  it("does not treat two root URLs as the same", () => {
    const a = makeItem({ sourceId, url: "https://example.com/", title: "Alpha" });
    const b = makeItem({ sourceId: makeSource().id, url: "https://example.com/", title: "Bravo" });
    expect(claimItemsToJudge(5, [], NOW)).toEqual([a.id, b.id]);
  });
});
