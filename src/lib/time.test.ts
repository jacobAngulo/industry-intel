import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, nextUtcMidnight, nowMs, setNowForTests, utcDay } from "./time";

afterEach(() => setNowForTests(null));

describe("time", () => {
  it("returns the real clock by default", () => {
    const before = Date.now();
    const value = nowMs();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });

  it("uses the function or the fixed number of setNowForTests, and null gives the real clock back", () => {
    setNowForTests(1_795_000_000_000);
    expect(nowMs()).toBe(1_795_000_000_000);

    let tick = 10;
    setNowForTests(() => (tick += 5));
    expect(nowMs()).toBe(15);
    expect(nowMs()).toBe(20);

    setNowForTests(null);
    expect(nowMs()).toBeGreaterThan(1_700_000_000_000);
  });

  it("gives the UTC day and the next UTC midnight", () => {
    const lateEvening = Date.UTC(2026, 10, 19, 23, 59, 59, 999);
    expect(utcDay(lateEvening)).toBe("2026-11-19");
    expect(utcDay(lateEvening + 1)).toBe("2026-11-20");
    expect(nextUtcMidnight(lateEvening)).toBe(Date.UTC(2026, 10, 20));
    // An instant that is exactly midnight gives the next midnight.
    expect(nextUtcMidnight(Date.UTC(2026, 10, 20))).toBe(Date.UTC(2026, 10, 20) + DAY_MS);

    setNowForTests(Date.UTC(2027, 0, 1, 0, 0, 1));
    expect(utcDay()).toBe("2027-01-01");
    expect(nextUtcMidnight()).toBe(Date.UTC(2027, 0, 2));
  });
});
