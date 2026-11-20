import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorError, type ConnectorContext, type RawItem } from "@/lib/connectors/types";
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
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { checkSource, dueSourceIds } from "./check";
import type { PipelineDeps } from "./types";

// A scripted connector instead of the real one (the type of each source is `blog`).
const fake = vi.hoisted(() => ({
  fetch: vi.fn(),
  needs: vi.fn((): { code: "x_token"; message: string } | null => null),
  validConfig: true,
}));
vi.mock("@/lib/connectors/registry", () => ({
  getConnector: () => ({
    type: "blog",
    label: "Fake",
    description: "",
    defaultIntervalMinutes: 60,
    maxAgeDays: 7,
    configSchema: {
      safeParse: (value: unknown) => (fake.validConfig ? { success: true, data: value } : { success: false }),
    },
    needs: fake.needs,
    keyOf: () => "fake",
    resolve: async () => [],
    fetch: fake.fetch,
  }),
}));

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;
let deps: PipelineDeps;

function raw(n: number, over: Partial<RawItem> = {}): RawItem {
  return {
    externalId: `e${n}`,
    url: `https://news.example.com/a/${n}`,
    title: `Title number ${n}`,
    publishedAt: NOW - n * HOUR_MS,
    kind: "article",
    text: `The text of item ${n}.`,
    ...over,
  };
}

function itemsOf(sourceId: number) {
  return t.sqlite
    .prepare("SELECT * FROM items WHERE source_id = ? ORDER BY id")
    .all(sourceId) as Array<{
    id: number;
    external_id: string;
    judge_status: string;
    skip_reason: string | null;
    story_id: number | null;
    canonical_url: string | null;
    content_hash: string;
    title: string;
  }>;
}

function sourceRow(id: number) {
  return t.sqlite.prepare("SELECT * FROM sources WHERE id = ?").get(id) as {
    cursor: string | null;
    next_check_at: number;
    check_requested_at: number | null;
    locked_until: number | null;
    last_error: string | null;
    last_success_at: number | null;
    last_checked_at: number | null;
    consecutive_failures: number;
  };
}

function checks(sourceId: number) {
  return t.sqlite.prepare("SELECT * FROM source_checks WHERE source_id = ? ORDER BY id").all(sourceId) as Array<{
    ok: number;
    items_found: number;
    items_new: number;
    error: string | null;
  }>;
}

function feedWithSource(over: Parameters<typeof makeSource>[0] = {}) {
  const feed = makeFeed();
  const source = makeSource({ checkIntervalMinutes: 60, ...over });
  linkFeedSource(feed.id, source.id);
  return { feed, source };
}

beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
  deps = { llm: new FakeLlm(), http: new FakeHttp(), search: null, mail: null, now: () => NOW };
  fake.fetch.mockReset();
  fake.needs.mockReset();
  fake.needs.mockReturnValue(null);
  fake.validConfig = true;
});

afterEach(() => {
  t.cleanup();
});

describe("dueSourceIds", () => {
  it("lists requested checks first, then the oldest next_check_at; skips paused, locked, and not-due sources", () => {
    const late = makeSource({ nextCheckAt: NOW - 1000 });
    const early = makeSource({ nextCheckAt: NOW - 5000 });
    const requested = makeSource({ nextCheckAt: NOW + DAY_MS, checkRequestedAt: NOW - 10 });
    makeSource({ nextCheckAt: NOW - 9000, paused: true });
    makeSource({ nextCheckAt: NOW - 9000, lockedUntil: NOW + MINUTE_MS });
    makeSource({ nextCheckAt: NOW + HOUR_MS });
    const expiredLock = makeSource({ nextCheckAt: NOW - 100, lockedUntil: NOW - 1 });
    expect(dueSourceIds(10, NOW)).toEqual([requested.id, early.id, late.id, expiredLock.id]);
    expect(dueSourceIds(2, NOW)).toEqual([requested.id, early.id]);
  });
});

describe("checkSource: the needs() rule and the claim", () => {
  it("postpones a source that needs a credential: no fetch, no check row, failures unchanged", async () => {
    const { source } = feedWithSource({ consecutiveFailures: 2, checkRequestedAt: NOW - 5 });
    fake.needs.mockReturnValue({ code: "x_token", message: "Needs an X API token." });
    const result = await checkSource(source.id, deps);
    expect(result).toEqual({ ran: false, ok: false, itemsFound: 0, itemsNew: 0 });
    expect(fake.fetch).not.toHaveBeenCalled();
    const row = sourceRow(source.id);
    expect(row.next_check_at).toBe(NOW + 60 * MINUTE_MS);
    expect(row.check_requested_at).toBeNull();
    expect(row.consecutive_failures).toBe(2);
    expect(row.locked_until).toBeNull();
    expect(checks(source.id)).toHaveLength(0);
  });

  it("does not run a locked or paused source", async () => {
    const locked = makeSource({ lockedUntil: NOW + MINUTE_MS });
    const paused = makeSource({ paused: true });
    expect((await checkSource(locked.id, deps)).ran).toBe(false);
    expect((await checkSource(paused.id, deps)).ran).toBe(false);
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("holds the 5-minute lock during the fetch and calls fetch in poll mode with limit 30 and a signal", async () => {
    const { source } = feedWithSource();
    let lockDuringFetch: number | null = null;
    fake.fetch.mockImplementation(async (args: { mode: string; limit: number; ctx: ConnectorContext }) => {
      lockDuringFetch = sourceRow(source.id).locked_until;
      expect(args.mode).toBe("poll");
      expect(args.limit).toBe(30);
      expect(args.ctx.signal).toBeInstanceOf(AbortSignal);
      expect(args.ctx.http).toBe(deps.http);
      return { items: [], cursor: { page: 1 } };
    });
    const result = await checkSource(source.id, deps);
    expect(result.ran).toBe(true);
    expect(lockDuringFetch).toBe(NOW + 5 * MINUTE_MS);
    expect(sourceRow(source.id).locked_until).toBeNull();
  });
});

describe("checkSource: success bookkeeping and storing items", () => {
  it("stores the cursor and resets the failure state; next check = interval ± 10 %", async () => {
    const { source } = feedWithSource({ consecutiveFailures: 3, lastError: "old" });
    fake.fetch.mockResolvedValue({ items: [raw(1)], cursor: { etag: "v2" } });
    const result = await checkSource(source.id, deps);
    expect(result).toEqual({ ran: true, ok: true, itemsFound: 1, itemsNew: 1 });
    const row = sourceRow(source.id);
    expect(JSON.parse(row.cursor ?? "null")).toEqual({ etag: "v2" });
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.last_success_at).toBe(NOW);
    expect(row.last_checked_at).toBe(NOW);
    expect(row.next_check_at).toBeGreaterThanOrEqual(NOW + 54 * MINUTE_MS);
    expect(row.next_check_at).toBeLessThanOrEqual(NOW + 66 * MINUTE_MS);
    expect(checks(source.id)).toEqual([expect.objectContaining({ ok: 1, items_found: 1, items_new: 1, error: null })]);
  });

  it("first poll: only the 8 newest items that pass the other rules are pending", async () => {
    const { source } = feedWithSource();
    const list = Array.from({ length: 12 }, (_, i) => raw(i + 1));
    list.push(raw(50, { publishedAt: NOW - 10 * DAY_MS })); // too old for maxAgeDays 7
    list.push(raw(51, { title: "", text: "  " }));
    list.push(raw(52, { skip: "baseline" }));
    fake.fetch.mockResolvedValue({ items: list, cursor: null });
    await checkSource(source.id, deps);
    const rows = itemsOf(source.id);
    const byExt = new Map(rows.map((row) => [row.external_id, row]));
    for (let n = 1; n <= 8; n += 1) expect(byExt.get(`e${n}`)?.judge_status).toBe("pending");
    for (let n = 9; n <= 12; n += 1) expect(byExt.get(`e${n}`)?.skip_reason).toBe("first_run_cap");
    expect(byExt.get("e50")?.skip_reason).toBe("too_old");
    expect(byExt.get("e51")?.skip_reason).toBe("empty");
    expect(byExt.get("e52")?.skip_reason).toBe("baseline");
  });

  it("later polls have no first-run cap, and a known external id is left unchanged", async () => {
    const { source } = feedWithSource({ lastSuccessAt: NOW - DAY_MS });
    makeItem({ sourceId: source.id, externalId: "e1", title: "Old title", judgeStatus: "judged" });
    fake.fetch.mockResolvedValue({ items: Array.from({ length: 12 }, (_, i) => raw(i + 1)), cursor: null });
    const result = await checkSource(source.id, deps);
    expect(result.itemsNew).toBe(11);
    const rows = itemsOf(source.id);
    expect(rows).toHaveLength(12);
    expect(rows.find((row) => row.external_id === "e1")?.title).toBe("Old title");
    expect(rows.filter((row) => row.judge_status === "pending")).toHaveLength(11);
  });

  it("marks items no_feed when the source is in no active feed (an archived feed does not count)", async () => {
    const feed = makeFeed({ archivedAt: NOW - 1000 });
    const source = makeSource();
    linkFeedSource(feed.id, source.id);
    fake.fetch.mockResolvedValue({ items: [raw(1)], cursor: null });
    await checkSource(source.id, deps);
    expect(itemsOf(source.id)[0]?.skip_reason).toBe("no_feed");
  });

  it("stores the canonical URL, a content hash, and at most 10 canonical links", async () => {
    const { source } = feedWithSource();
    const links = Array.from({ length: 12 }, (_, i) => `https://Ref.example.com/p/${i}/?utm_source=x`);
    fake.fetch.mockResolvedValue({
      items: [raw(1, { url: "https://News.Example.com/a/1/?utm_medium=feed#top", links })],
      cursor: null,
    });
    await checkSource(source.id, deps);
    const [item] = itemsOf(source.id);
    expect(item?.canonical_url).toBe("https://news.example.com/a/1");
    expect(item?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = t.sqlite.prepare("SELECT url FROM item_links WHERE item_id = ? ORDER BY url").all(item?.id) as Array<{ url: string }>;
    expect(stored).toHaveLength(10);
    expect(stored[0]?.url).toBe("https://ref.example.com/p/0");
  });

  it("joins a pending item silently to a story of another source with the same URL", async () => {
    const { feed, source } = feedWithSource();
    const other = makeSource();
    linkFeedSource(feed.id, other.id);
    const story = makeStory({ substance: "news" });
    makeItem({ sourceId: other.id, storyId: story.id, url: "https://news.example.com/a/1" });
    makeJudgement({ feedId: feed.id, storyId: story.id });
    fake.fetch.mockResolvedValue({ items: [raw(1)], cursor: null });
    await checkSource(source.id, deps);
    const [item] = itemsOf(source.id);
    expect(item?.story_id).toBe(story.id);
    expect(item?.judge_status).toBe("judged");
    const counts = t.sqlite.prepare("SELECT item_count, source_count FROM stories WHERE id = ?").get(story.id);
    expect(counts).toEqual({ item_count: 2, source_count: 2 });
  });

  it("keeps a silently joined item pending when a feed of its source has no judgement of the story", async () => {
    const { source } = feedWithSource();
    const other = makeSource();
    const story = makeStory({ substance: "news" });
    makeItem({ sourceId: other.id, storyId: story.id, url: "https://news.example.com/a/1" });
    fake.fetch.mockResolvedValue({ items: [raw(1)], cursor: null });
    await checkSource(source.id, deps);
    const [item] = itemsOf(source.id);
    expect(item?.story_id).toBe(story.id);
    expect(item?.judge_status).toBe("pending");
  });
});

describe("checkSource: failures", () => {
  it("keeps the cursor on failure, counts the failure, backs off, and writes a warn event", async () => {
    const { source } = feedWithSource({ cursor: { etag: "v1" }, consecutiveFailures: 1 });
    fake.fetch.mockRejectedValue(new ConnectorError("network", "The feed address cannot be reached."));
    const result = await checkSource(source.id, deps);
    expect(result).toEqual({ ran: true, ok: false, itemsFound: 0, itemsNew: 0, error: "The feed address cannot be reached." });
    const row = sourceRow(source.id);
    expect(JSON.parse(row.cursor ?? "null")).toEqual({ etag: "v1" });
    expect(row.consecutive_failures).toBe(2);
    expect(row.last_error).toBe("The feed address cannot be reached.");
    expect(row.next_check_at).toBe(NOW + 60 * MINUTE_MS * 4);
    expect(row.locked_until).toBeNull();
    expect(checks(source.id)).toEqual([expect.objectContaining({ ok: 0, error: "The feed address cannot be reached." })]);
    const events = t.sqlite.prepare("SELECT level, scope FROM events").all();
    expect(events).toEqual([{ level: "warn", scope: "source" }]);
  });

  it("caps the back-off at 24 hours", async () => {
    const { source } = feedWithSource({ consecutiveFailures: 9 });
    fake.fetch.mockRejectedValue(new Error("boom"));
    const result = await checkSource(source.id, deps);
    expect(result.error).toBe("The check failed: boom");
    expect(sourceRow(source.id).next_check_at).toBe(NOW + DAY_MS);
  });

  it("budget: next check at the next UTC midnight, failures unchanged, a failed check row", async () => {
    const { source } = feedWithSource({ consecutiveFailures: 1, cursor: { sinceId: "5" } });
    fake.fetch.mockRejectedValue(new ConnectorError("budget", "The daily X post limit is used."));
    await checkSource(source.id, deps);
    const row = sourceRow(source.id);
    expect(row.next_check_at).toBe(nextUtcMidnight(NOW));
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_error).toBe("The daily X post limit is used.");
    expect(JSON.parse(row.cursor ?? "null")).toEqual({ sinceId: "5" });
    expect(checks(source.id)).toEqual([expect.objectContaining({ ok: 0 })]);
  });

  it("an invalid config is a failure of the check", async () => {
    const { source } = feedWithSource();
    fake.validConfig = false;
    const result = await checkSource(source.id, deps);
    expect(result.ok).toBe(false);
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(sourceRow(source.id).consecutive_failures).toBe(1);
  });
});

describe("checkSource: always", () => {
  it("keeps the newest 50 check rows of the source", async () => {
    const { source } = feedWithSource();
    const insert = t.sqlite.prepare(
      "INSERT INTO source_checks (source_id, started_at, finished_at, ok, items_found, items_new) VALUES (?, ?, ?, 1, 0, 0)",
    );
    for (let i = 0; i < 55; i += 1) insert.run(source.id, NOW - (100 - i) * MINUTE_MS, NOW - (100 - i) * MINUTE_MS);
    fake.fetch.mockResolvedValue({ items: [], cursor: null });
    await checkSource(source.id, deps);
    const rows = t.sqlite.prepare("SELECT started_at FROM source_checks WHERE source_id = ? ORDER BY started_at DESC").all(source.id) as Array<{ started_at: number }>;
    expect(rows).toHaveLength(50);
    expect(rows[0]?.started_at).toBe(NOW);
  });

  it("clears check_requested_at only when it is not later than the start of the check", async () => {
    const { source } = feedWithSource({ checkRequestedAt: NOW - 1 });
    fake.fetch.mockResolvedValue({ items: [], cursor: null });
    await checkSource(source.id, deps);
    expect(sourceRow(source.id).check_requested_at).toBeNull();

    const second = feedWithSource({ checkRequestedAt: NOW - 1 }).source;
    fake.fetch.mockImplementation(async () => {
      t.sqlite.prepare("UPDATE sources SET check_requested_at = ? WHERE id = ?").run(NOW + 500, second.id);
      throw new ConnectorError("network", "down");
    });
    await checkSource(second.id, deps);
    expect(sourceRow(second.id).check_requested_at).toBe(NOW + 500);
  });
});
