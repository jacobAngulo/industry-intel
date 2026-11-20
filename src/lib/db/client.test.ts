import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "@/lib/db/client";
import { isUniqueViolation, sqliteErrorCode } from "@/lib/db/errors";
import { feeds, items, settings, sources, stories } from "@/lib/db/schema";
import { defaultFeedDefaults, DEFAULT_RELEVANCE_PRIORITIES, EMPTY_BRIEF_FORMAT_OVERRIDE } from "@/lib/types";

const MIGRATION_COUNT = (
  JSON.parse(fs.readFileSync(path.resolve("drizzle/meta/_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function testDb(): TestDb {
  const t = createTestDb();
  cleanups.push(t.cleanup);
  return t;
}

function tempDatabaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "industry-intel-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "shared.db");
}

type ChildResult = { code: number | null; stdout: string; stderr: string };

/** Starts the child processes, waits until each is ready, then starts all at one time. */
async function runChildren(
  mode: "migrate" | "write" | "transact",
  databaseFile: string,
  count: number,
): Promise<ChildResult[]> {
  const fixture = path.resolve("src/lib/db/__fixtures__/db-child.ts");
  const children = Array.from({ length: count }, () =>
    spawn(process.execPath, ["--import", "tsx", fixture, mode], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: databaseFile },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );

  const results = children.map(
    (child) =>
      new Promise<ChildResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      }),
  );
  const ready = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        const onData = (chunk: unknown) => {
          if (String(chunk).includes("ready")) {
            child.stdout.off("data", onData);
            resolve();
          }
        };
        child.stdout.on("data", onData);
        child.on("close", () => resolve());
      }),
  );

  await Promise.all(ready);
  const startAt = Date.now() + 150;
  for (const child of children) child.stdin.end(`go ${startAt}\n`);
  return Promise.all(results);
}

function lastJsonLine(stdout: string): Record<string, number> {
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line) as Record<string, number>;
}

const ALL_TABLES = [
  "settings",
  "topics",
  "feeds",
  "feed_topics",
  "sources",
  "source_checks",
  "source_flags",
  "feed_sources",
  "items",
  "item_links",
  "stories",
  "stories_fts",
  "judgements",
  "feedback",
  "analyses",
  "digests",
  "alerts",
  "rejudge_requests",
  "usage_daily",
  "events",
  "activity",
  "worker_state",
];

function insertFeed(t: TestDb, slug: string): number {
  const defaults = defaultFeedDefaults("UTC");
  return t.db
    .insert(feeds)
    .values({
      slug,
      name: slug,
      exclusions: [],
      relevancePriorities: DEFAULT_RELEVANCE_PRIORITIES,
      briefFormat: EMPTY_BRIEF_FORMAT_OVERRIDE,
      digest: defaults.digest,
      quietHours: defaults.quietHours,
      alerts: defaults.alerts,
      createdAt: 1,
      updatedAt: 1,
    })
    .returning({ id: feeds.id })
    .get().id;
}

describe("createTestDb", () => {
  it("applies all migrations and sets the pragmas", () => {
    const { sqlite } = testDb();

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];
    expect(tables).toEqual(expect.arrayContaining(ALL_TABLES));
    // The proof tables of the scaffold are gone.
    expect(tables).not.toEqual(expect.arrayContaining(["heartbeats"]));

    const applied = sqlite.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get();
    expect(applied).toBe(MIGRATION_COUNT);

    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(1); // 1 = NORMAL
  });

  it("gives each test its own database and does not seed it", () => {
    const a = testDb();
    const b = testDb();
    insertFeed(a, "one");
    expect(a.db.select().from(feeds).all()).toHaveLength(1);
    expect(b.db.select().from(feeds).all()).toHaveLength(0);
    expect(a.file).not.toBe(b.file);
    // No seed: no settings row, also no `seeded_at`.
    expect(a.db.select().from(settings).all()).toEqual([]);
  });

  it("reads and writes JSON columns through drizzle and enforces the unique keys", () => {
    const t = testDb();
    const feedId = insertFeed(t, "radar");
    const feed = t.db.select().from(feeds).all()[0];
    expect(feed).toMatchObject({ id: feedId, minRelevance: 60, halfLifeHours: 48, exclusions: [], archivedAt: null });
    expect(feed?.digest.frequency).toBe("weekdays");

    // The query builder throws the SqliteError itself (the code is `error.code`).
    let caught: unknown;
    try {
      insertFeed(t, "radar");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(sqliteErrorCode(caught)).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(isUniqueViolation(caught)).toBe(true);

    // A raw `db.run(sql)` call wraps the SQLite error (the code is `error.cause.code`).
    let wrapped: unknown;
    try {
      t.db.run(sql`INSERT INTO topics (slug, name, created_at) VALUES ('a', 'A', 1), ('a', 'A', 1)`);
    } catch (error) {
      wrapped = error;
    }
    expect((wrapped as Error).cause).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });

  it("cascades from a source to its items and sets items.story_id to NULL when the story goes", () => {
    const { db } = testDb();
    const sourceId = db
      .insert(sources)
      .values({
        type: "blog",
        key: "blog:https://example.com/feed.xml",
        name: "Example",
        config: { feedUrl: "https://example.com/feed.xml" },
        checkIntervalMinutes: 60,
        createdAt: 1,
        updatedAt: 1,
      })
      .returning({ id: sources.id })
      .get().id;
    const storyId = db
      .insert(stories)
      .values({
        headline: "A story",
        summary: ["One."],
        category: "release",
        entities: [],
        substance: "news",
        firstSeenAt: 1,
        lastItemAt: 1,
        freshAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .returning({ id: stories.id })
      .get().id;
    db.insert(items)
      .values({ sourceId, externalId: "a", fetchedAt: 1, kind: "article", meta: {}, storyId })
      .run();

    db.delete(stories).run();
    expect(db.select().from(items).all()[0]).toMatchObject({ storyId: null, judgeStatus: "pending" });

    db.delete(sources).run();
    expect(db.select().from(items).all()).toEqual([]);
  });

  it("runs an FTS5 MATCH query on stories_fts (the table from the custom migration)", () => {
    const { sqlite } = testDb();

    const insert = sqlite.prepare("INSERT INTO stories_fts (rowid, headline, summary, entities) VALUES (?, ?, ?, ?)");
    insert.run(1, "Turbine blades", "A new alloy increases the life of turbine blades.", "Acme");
    insert.run(2, "Grid storage", "Sodium batteries decrease the cost of grid storage.", "Volt Works");

    const match = sqlite.prepare("SELECT rowid FROM stories_fts WHERE stories_fts MATCH ? ORDER BY rank");
    // The porter tokenizer finds "battery" for the query "batteries".
    expect(match.pluck().all("battery")).toEqual([2]);
    expect(match.pluck().all("turbine AND alloy")).toEqual([1]);
    expect(match.pluck().all("entities:volt")).toEqual([2]);
    expect(match.pluck().all("nothing")).toEqual([]);
  });
});

describe("two or more processes on one database file", () => {
  it("applies each migration one time when 4 processes start at the same moment", async () => {
    const file = tempDatabaseFile();

    const results = await runChildren("migrate", file, 4);
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }

    const sqlite = new Database(file, { readonly: true });
    try {
      const applied = sqlite.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get();
      expect(applied).toBe(MIGRATION_COUNT);
      const ftsTables = sqlite
        .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'stories_fts'")
        .pluck()
        .get();
      expect(ftsTables).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it(
    "lets 2 processes each do 200 writes at the same time with no 'database is locked' error",
    { retry: 2 },
    async () => {
      const file = tempDatabaseFile();

      const results = await runChildren("write", file, 2);
      for (const result of results) {
        expect(result.stderr).not.toMatch(/database is locked|SQLITE_BUSY/i);
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
      }

      const [a, b] = results.map((result) => lastJsonLine(result.stdout));
      expect(a?.written).toBe(200);
      expect(b?.written).toBe(200);
      // The two write periods overlap: the writes were concurrent.
      expect(a!.first).toBeLessThanOrEqual(b!.last!);
      expect(b!.first).toBeLessThanOrEqual(a!.last!);

      const sqlite = new Database(file, { readonly: true });
      try {
        expect(sqlite.prepare("SELECT count(*) FROM events").pluck().get()).toBe(400);
      } finally {
        sqlite.close();
      }
    },
  );

  // In WAL mode a DEFERRED transaction that reads, then writes, fails at once
  // with SQLITE_BUSY_SNAPSHOT ("database is locked") if the other process
  // wrote after the read. busy_timeout does not help. IMMEDIATE is the fix.
  it("lets 2 processes each do 200 read-then-write transactions with behavior 'immediate'", async () => {
    const file = tempDatabaseFile();

    const results = await runChildren("transact", file, 2);
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }

    const sqlite = new Database(file, { readonly: true });
    try {
      expect(sqlite.prepare("SELECT count(*) FROM events").pluck().get()).toBe(400);
    } finally {
      sqlite.close();
    }
  });
});
