import { describe, expect, it } from "vitest";

import { pathMatches } from "./paths";
import { formatAbsoluteUtc, formatClock, formatDateUtc, formatRelative } from "./time-format";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0); // 20 Nov 2026 12:00 UTC
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("formatRelative", () => {
  it("formats the past", () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 5 * MIN, NOW)).toBe("5 min ago");
    expect(formatRelative(NOW - 59 * MIN, NOW)).toBe("59 min ago");
    expect(formatRelative(NOW - 3 * H - 20 * MIN, NOW)).toBe("3 h ago");
    expect(formatRelative(NOW - 2 * D, NOW)).toBe("2 d ago");
    expect(formatRelative(NOW - 13 * D, NOW)).toBe("13 d ago");
  });

  it("formats the future", () => {
    expect(formatRelative(NOW + 10_000, NOW)).toBe("in less than a minute");
    expect(formatRelative(NOW + 40 * MIN, NOW)).toBe("in 40 min");
    expect(formatRelative(NOW + 4 * H, NOW)).toBe("in 4 h");
    expect(formatRelative(NOW + 3 * D, NOW)).toBe("in 3 d");
  });

  it("gives a UTC date after 14 days, with the year when it differs", () => {
    expect(formatRelative(NOW - 20 * D, NOW)).toBe("31 Oct");
    expect(formatRelative(Date.UTC(2025, 0, 5), NOW)).toBe("5 Jan 2025");
  });
});

describe("absolute formats", () => {
  it("formats a stable UTC time", () => {
    expect(formatAbsoluteUtc(Date.UTC(2026, 10, 19, 14, 5))).toBe("2026-11-19 14:05 UTC");
    expect(formatDateUtc(Date.UTC(2026, 10, 19))).toBe("19 Nov 2026");
  });

  it("formats a clock time in a time zone", () => {
    expect(formatClock(Date.UTC(2026, 10, 19, 14, 5), "UTC")).toBe("14:05");
    expect(formatClock(Date.UTC(2026, 10, 19, 14, 5), "Europe/Berlin")).toBe("15:05");
    // A bad zone falls back to UTC.
    expect(formatClock(Date.UTC(2026, 10, 19, 14, 5), "Not/AZone")).toBe("14:05");
  });
});

describe("pathMatches", () => {
  it("matches the path and the paths below it", () => {
    expect(pathMatches("/f/radar", "/f/radar")).toBe(true);
    expect(pathMatches("/f/radar/story/4", "/f/radar")).toBe(true);
    expect(pathMatches("/f/radar-2", "/f/radar")).toBe(false);
    expect(pathMatches("/f/radar/story/4", "/f/radar", "exact")).toBe(false);
    expect(pathMatches("/sources", "/sources?type=podcast")).toBe(true);
  });

  it("matches / only exactly", () => {
    expect(pathMatches("/", "/")).toBe(true);
    expect(pathMatches("/sources", "/")).toBe(false);
  });
});
