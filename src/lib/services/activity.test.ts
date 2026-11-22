import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activity } from "@/lib/db/schema";
import { installTestDb, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { listActivity, logActivity } from "./activity";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
});
afterEach(() => t.cleanup());

describe("logActivity", () => {
  it("writes one activity row", () => {
    setNowForTests(1_800_000_000_000);
    logActivity({ name: "Dana", userId: "c1" }, "source.create", "source", 12, 'Added the source "Claude Code releases".');
    logActivity({ name: "n".repeat(200), userId: "c2" }, "settings.update", "settings", null, "x".repeat(900));

    const rows = t.db.select().from(activity).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      at: 1_800_000_000_000,
      actor: "Dana",
      action: "source.create",
      entityType: "source",
      entityId: 12,
      summary: 'Added the source "Claude Code releases".',
    });
    expect(rows[1]).toMatchObject({ actor: "n".repeat(120), entityId: null });
    expect(rows[1]?.summary.length).toBe(500);
  });

  it("is part of the transaction of the caller", () => {
    expect(() =>
      t.db.transaction(
        () => {
          logActivity({ name: "Dana", userId: "c1" }, "feed.create", "feed", 1, "Created a feed.");
          throw new Error("roll back");
        },
        { behavior: "immediate" },
      ),
    ).toThrow("roll back");
    expect(t.db.select().from(activity).all()).toEqual([]);
  });
});

describe("listActivity", () => {
  it("returns the rows newest first, the last 100 by default", async () => {
    const actor = { name: "Dana", userId: "c1" };
    for (let i = 0; i < 105; i += 1) {
      setNowForTests(1_800_000_000_000 + i);
      logActivity(actor, "feed.update", "feed", i, `Change ${i}`);
    }
    const rows = await listActivity();
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({ at: 1_800_000_000_104, actor: "Dana", action: "feed.update", entityType: "feed", entityId: 104, summary: "Change 104" });
    expect(rows[99]?.entityId).toBe(5);
    expect((await listActivity(3)).map((row) => row.entityId)).toEqual([104, 103, 102]);
    expect(await listActivity(0)).toHaveLength(1);
  });
});
