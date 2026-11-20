// The seed hook of openDatabase. The seed itself is a mock here, so this test
// holds for the phase 1 stub and for the real seed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/seed", () => ({ runSeed: vi.fn(() => false) }));

import { createTestDb, getDb, getSqlite, openDatabase, setDbHandleForTests, type Db } from "@/lib/db/client";
import { settings, topics } from "@/lib/db/schema";
import { runSeed } from "@/lib/seed";

const seed = vi.mocked(runSeed);
const cleanups: Array<() => void> = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "industry-intel-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "seed.db");
}

function open(file: string, seedOption: boolean) {
  const handle = openDatabase(file, { seed: seedOption });
  cleanups.push(() => {
    if (handle.sqlite.open) handle.sqlite.close();
  });
  return handle;
}

const writeTopic = (db: Db) => db.insert(topics).values({ slug: "seeded", name: "Seeded", createdAt: 1 }).run();
const settingKeys = (db: Db) => db.select({ key: settings.key }).from(settings).all().map((row) => row.key);

beforeEach(() => {
  seed.mockReset();
  seed.mockReturnValue(false);
});
afterEach(() => {
  setDbHandleForTests(null);
  // The databases close before their folders go.
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("the seed hook of openDatabase", () => {
  it("does not call the seed without `seed: true` (the default of createTestDb)", () => {
    const t = createTestDb();
    cleanups.push(t.cleanup);
    open(tempFile(), false);
    expect(seed).not.toHaveBeenCalled();
  });

  it("writes no `seeded_at` row while the seed returns false, and calls the seed again at the next open", () => {
    const file = tempFile();
    const first = open(file, true);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith(first.db);
    expect(settingKeys(first.db)).toEqual([]);
    first.sqlite.close();

    open(file, true);
    expect(seed).toHaveBeenCalledTimes(2);
  });

  it("writes `seeded_at` in the transaction of the seed when the seed returns true, and seeds one time only", () => {
    seed.mockImplementation((db) => {
      writeTopic(db);
      return true;
    });
    const file = tempFile();
    const before = Date.now();
    const first = open(file, true);

    expect(first.db.select().from(topics).all()).toHaveLength(1);
    const row = first.db.select().from(settings).all()[0];
    expect(row).toMatchObject({ key: "seeded_at", updatedBy: "Starter set" });
    expect(row?.value).toBeGreaterThanOrEqual(before);
    first.sqlite.close();

    const second = open(file, true);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(second.db.select().from(topics).all()).toHaveLength(1);
  });

  it("rolls the seed back when it throws, and the open fails", () => {
    seed.mockImplementation((db) => {
      writeTopic(db);
      throw new Error("seed failed");
    });
    const file = tempFile();
    expect(() => openDatabase(file, { seed: true })).toThrow("seed failed");

    seed.mockReset();
    seed.mockReturnValue(false);
    const again = open(file, true);
    expect(again.db.select().from(topics).all()).toEqual([]);
    expect(settingKeys(again.db)).toEqual([]);
  });

  it("gives the seed the same connection through getDb() and getSqlite(), and allows a nested transaction", () => {
    let sameDb = false;
    let sameSqlite = false;
    seed.mockImplementation((db) => {
      sameDb = getDb() === db;
      sameSqlite = getSqlite().inTransaction;
      getDb().transaction((tx) => tx.insert(topics).values({ slug: "nested", name: "Nested", createdAt: 1 }).run(), {
        behavior: "immediate",
      });
      return true;
    });
    const handle = open(tempFile(), true);
    expect(sameDb).toBe(true);
    expect(sameSqlite).toBe(true);
    expect(handle.db.select().from(topics).all()).toHaveLength(1);
    expect(settingKeys(handle.db)).toEqual(["seeded_at"]);
  });

  it("keeps a `seeded_at` row that the seed wrote itself", () => {
    seed.mockImplementation((db) => {
      db.insert(settings).values({ key: "seeded_at", value: 42, updatedAt: 42, updatedBy: "Seed" }).run();
      return true;
    });
    const handle = open(tempFile(), true);
    expect(handle.db.select().from(settings).all()).toEqual([{ key: "seeded_at", value: 42, updatedAt: 42, updatedBy: "Seed" }]);
  });
});
