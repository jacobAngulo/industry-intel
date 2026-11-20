import { describe, expect, it } from "vitest";

import {
  DISMISSED_ALERTS_KEY,
  DISMISSED_ALERTS_MAX,
  dismissAlerts,
  hasUndismissedAlerts,
  parseDismissedAlerts,
  readDismissedAlerts,
  undismissedAlerts,
} from "./dismissed-alerts";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class BrokenStorage {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

describe("dismissed alerts", () => {
  it("parses only positive integer ids", () => {
    expect(parseDismissedAlerts(null)).toEqual([]);
    expect(parseDismissedAlerts("not json")).toEqual([]);
    expect(parseDismissedAlerts('{"a":1}')).toEqual([]);
    expect(parseDismissedAlerts('[1, "2", 3.5, -4, 5]')).toEqual([1, 5]);
  });

  it("stores ids under the key, without duplicates", () => {
    const s = new MemoryStorage();
    expect(readDismissedAlerts(s)).toEqual([]);
    expect(dismissAlerts([3, 4], s)).toEqual([3, 4]);
    expect(dismissAlerts([4, 5], s)).toEqual([3, 4, 5]);
    expect(s.getItem(DISMISSED_ALERTS_KEY)).toBe("[3,4,5]");
    expect(readDismissedAlerts(s)).toEqual([3, 4, 5]);
  });

  it("keeps the newest ids only", () => {
    const s = new MemoryStorage();
    const many = Array.from({ length: DISMISSED_ALERTS_MAX + 10 }, (_, i) => i + 1);
    const kept = dismissAlerts(many, s);
    expect(kept).toHaveLength(DISMISSED_ALERTS_MAX);
    expect(kept[0]).toBe(11);
  });

  it("works with blocked or missing storage", () => {
    expect(readDismissedAlerts(new BrokenStorage())).toEqual([]);
    expect(dismissAlerts([1], new BrokenStorage())).toEqual([1]);
    expect(readDismissedAlerts(null)).toEqual([]);
  });

  it("tells when a feed has an alert that is not dismissed", () => {
    expect(hasUndismissedAlerts([], [])).toBe(false);
    expect(hasUndismissedAlerts([1, 2], [1])).toBe(true);
    expect(hasUndismissedAlerts([1, 2], [2, 1])).toBe(false);
    expect(undismissedAlerts([1, 2, 3], [2])).toEqual([1, 3]);
  });
});
