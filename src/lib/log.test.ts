import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDb, setDbHandleForTests } from "@/lib/db/client";
import { events } from "@/lib/db/schema";
import { installTestDb, setNowForTests } from "@/test/helpers";

import { logEvent } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
  setNowForTests(null);
});

describe("logEvent", () => {
  it("writes one console line and one events row", () => {
    const t = installTestDb();
    try {
      setNowForTests(Date.UTC(2026, 10, 19, 8, 30));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      logEvent("warn", "pipeline", "The source check failed.", { sourceId: 7 });
      logEvent("info", "worker", "Started.");

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("WARN pipeline: The source check failed.");
      expect(log).toHaveBeenCalledTimes(1);

      const rows = t.db.select().from(events).all();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        at: Date.UTC(2026, 10, 19, 8, 30),
        level: "warn",
        scope: "pipeline",
        message: "The source check failed.",
        data: { sourceId: 7 },
      });
      expect(rows[1]).toMatchObject({ level: "info", scope: "worker", data: null });
    } finally {
      t.cleanup();
    }
  });

  it("cuts a long message and data that is too large", () => {
    const t = installTestDb();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      logEvent("error", "llm", "x".repeat(2000), { big: "y".repeat(5000) });
      const row = t.db.select().from(events).all()[0];
      expect(row?.message.length).toBe(500);
      expect(JSON.stringify(row?.data).length).toBeLessThan(2200);
    } finally {
      t.cleanup();
    }
  });

  it("does not throw when the row cannot be written", () => {
    const t = installTestDb();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // A closed database: each write fails.
    t.sqlite.close();
    try {
      expect(() => logEvent("info", "test", "Still fine.")).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain("The event row was not written");
    } finally {
      setDbHandleForTests(null);
      closeDb();
      t.cleanup();
    }
  });
});
