import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usageDaily } from "@/lib/db/schema";
import { createEnv } from "@/lib/env";
import { installTestDb, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { createUsageMeter, usageLimit } from "./usage";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(Date.UTC(2026, 10, 19, 12, 0, 0));
});
afterEach(() => t.cleanup());

describe("usageLimit", () => {
  it("gives the limits of the specification and Infinity for the other metrics", () => {
    const env = createEnv({});
    expect(usageLimit("llm_calls", env)).toBe(1500);
    expect(usageLimit("llm_calls_preview", env)).toBe(100);
    expect(usageLimit("x_posts", env)).toBe(300);
    expect(usageLimit("web_searches", env)).toBe(50);
    expect(usageLimit("llm_input_tokens", env)).toBe(Infinity);
    expect(usageLimit("llm_output_tokens", env)).toBe(Infinity);
    expect(usageLimit("x_users", env)).toBe(Infinity);

    const custom = createEnv({ LLM_MAX_CALLS_PER_DAY: "20", X_MAX_POSTS_PER_DAY: "0", WEB_SEARCH_MAX_PER_DAY: "x" });
    expect(usageLimit("llm_calls", custom)).toBe(20);
    expect(usageLimit("x_posts", custom)).toBe(0);
    expect(usageLimit("web_searches", custom)).toBe(50);
  });
});

describe("createUsageMeter", () => {
  it("adds only when the limit allows it", () => {
    const usage = createUsageMeter(createEnv({ LLM_MAX_CALLS_PER_DAY: "3" }));
    expect(usage.today("llm_calls")).toBe(0);
    expect(usage.remaining("llm_calls")).toBe(3);

    expect(usage.take("llm_calls", 1)).toBe(true);
    expect(usage.take("llm_calls", 2)).toBe(true);
    expect(usage.take("llm_calls", 1)).toBe(false);
    expect(usage.today("llm_calls")).toBe(3);
    expect(usage.remaining("llm_calls")).toBe(0);
  });

  it("refuses a first take that is larger than the limit and writes no row", () => {
    const usage = createUsageMeter(createEnv({ X_MAX_POSTS_PER_DAY: "5" }));
    expect(usage.take("x_posts", 6)).toBe(false);
    expect(t.db.select().from(usageDaily).all()).toEqual([]);
    expect(usage.take("x_posts", 5)).toBe(true);
    expect(usage.take("x_posts", 1)).toBe(false);
    expect(usage.today("x_posts")).toBe(5);
  });

  it("refuses each take when the limit is 0", () => {
    const usage = createUsageMeter(createEnv({ WEB_SEARCH_MAX_PER_DAY: "0" }));
    expect(usage.take("web_searches", 1)).toBe(false);
    expect(usage.remaining("web_searches")).toBe(0);
  });

  it("has no limit for the metrics that the specification does not limit", () => {
    const usage = createUsageMeter(createEnv({}));
    expect(usage.take("x_users", 1_000_000)).toBe(true);
    usage.add("llm_input_tokens", 12_345);
    usage.add("llm_input_tokens", 55);
    expect(usage.today("llm_input_tokens")).toBe(12_400);
    expect(usage.remaining("llm_input_tokens")).toBe(Infinity);
    expect(usage.remaining("x_users")).toBe(Infinity);
  });

  it("add() does not test the limit", () => {
    const usage = createUsageMeter(createEnv({ LLM_MAX_CALLS_PER_DAY: "2" }));
    usage.add("llm_calls", 5);
    expect(usage.today("llm_calls")).toBe(5);
    expect(usage.remaining("llm_calls")).toBe(0);
    expect(usage.take("llm_calls", 1)).toBe(false);
  });

  it("keeps the metrics apart", () => {
    const usage = createUsageMeter(createEnv({}));
    expect(usage.take("llm_calls", 2)).toBe(true);
    expect(usage.take("llm_calls_preview", 100)).toBe(true);
    expect(usage.take("llm_calls_preview", 1)).toBe(false);
    expect(usage.today("llm_calls")).toBe(2);
    expect(usage.today("llm_calls_preview")).toBe(100);
  });

  it("starts a new count at the change of the UTC day", () => {
    const usage = createUsageMeter(createEnv({ LLM_MAX_CALLS_PER_DAY: "2" }));
    setNowForTests(Date.UTC(2026, 10, 19, 23, 59, 59));
    expect(usage.take("llm_calls", 2)).toBe(true);
    expect(usage.take("llm_calls", 1)).toBe(false);

    setNowForTests(Date.UTC(2026, 10, 20, 0, 0, 0));
    expect(usage.today("llm_calls")).toBe(0);
    expect(usage.remaining("llm_calls")).toBe(2);
    expect(usage.take("llm_calls", 1)).toBe(true);

    const rows = t.db.select().from(usageDaily).all();
    expect(rows).toEqual(
      expect.arrayContaining([
        { day: "2026-11-19", metric: "llm_calls", value: 2 },
        { day: "2026-11-20", metric: "llm_calls", value: 1 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("the limit holds when two meters (two processes) take in turns", () => {
    const env = createEnv({ LLM_MAX_CALLS_PER_DAY: "10" });
    const web = createUsageMeter(env);
    const worker = createUsageMeter(env);
    let granted = 0;
    for (let i = 0; i < 20; i += 1) {
      if ((i % 2 ? web : worker).take("llm_calls", 1)) granted += 1;
    }
    expect(granted).toBe(10);
    expect(web.today("llm_calls")).toBe(10);
  });

  it("refuses an amount that is not a whole number, and a negative take", () => {
    const usage = createUsageMeter(createEnv({}));
    expect(() => usage.take("llm_calls", 0.5)).toThrow(RangeError);
    expect(() => usage.take("llm_calls", -1)).toThrow(RangeError);
    expect(usage.take("llm_calls", 0)).toBe(true);
  });
});
