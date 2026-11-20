import { describe, expect, it } from "vitest";

import type { DigestSettings, QuietHours } from "@/lib/types";

import { isQuietHours, occurrenceBefore, previousOccurrence, quietHoursEnd, zonedParts } from "./index";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function digest(overrides: Partial<DigestSettings> = {}): DigestSettings {
  return { frequency: "daily", weekday: 1, time: "08:30", timeZone: "UTC", maxStories: 10, ...overrides };
}

function quiet(start: string, end: string, enabled = true): QuietHours {
  return { enabled, start, end };
}

describe("zonedParts", () => {
  it("gives the local date, time, and weekday (0 = Sunday)", () => {
    // Friday 20 Nov 2026, 23:30 UTC = Saturday 00:30 in Berlin (CET, +1).
    expect(zonedParts(at("2026-11-20T23:30:00Z"), "UTC")).toEqual({
      year: 2026, month: 11, day: 20, hour: 23, minute: 30, weekday: 5,
    });
    expect(zonedParts(at("2026-11-20T23:30:00Z"), "Europe/Berlin")).toEqual({
      year: 2026, month: 11, day: 21, hour: 0, minute: 30, weekday: 6,
    });
    expect(zonedParts(at("2026-11-21T13:05:00Z"), "Australia/Sydney")).toMatchObject({ day: 22, hour: 0, minute: 5, weekday: 0 });
  });

  it("writes midnight as hour 0", () => {
    expect(zonedParts(at("2026-11-20T05:00:00Z"), "America/New_York")).toMatchObject({ hour: 0, minute: 0, day: 20 });
  });

  it("falls back to UTC for an invalid time zone and does not throw", () => {
    expect(() => zonedParts(0, "Not/AZone")).not.toThrow();
    expect(zonedParts(at("2026-11-20T10:15:00Z"), "Not/AZone")).toEqual(zonedParts(at("2026-11-20T10:15:00Z"), "UTC"));
    expect(zonedParts(at("2026-11-20T10:15:00Z"), "")).toMatchObject({ hour: 10, minute: 15 });
  });
});

describe("previousOccurrence: frequencies", () => {
  it("is null when the digest is off", () => {
    expect(previousOccurrence(at("2026-11-20T12:00:00Z"), digest({ frequency: "off" }))).toBeNull();
  });

  it("daily: today when the time has passed, else yesterday", () => {
    const d = digest({ time: "08:30" });
    expect(iso(previousOccurrence(at("2026-11-20T12:00:00Z"), d))).toBe("2026-11-20T08:30:00.000Z");
    expect(iso(previousOccurrence(at("2026-11-20T08:00:00Z"), d))).toBe("2026-11-19T08:30:00.000Z");
  });

  it("includes the scheduled instant itself (<= now)", () => {
    expect(iso(previousOccurrence(at("2026-11-20T08:30:00Z"), digest()))).toBe("2026-11-20T08:30:00.000Z");
  });

  it("daily in a time zone uses the local time", () => {
    const d = digest({ time: "08:30", timeZone: "Europe/Berlin" });
    // 08:30 CET = 07:30 UTC.
    expect(iso(previousOccurrence(at("2026-11-20T07:31:00Z"), d))).toBe("2026-11-20T07:30:00.000Z");
    expect(iso(previousOccurrence(at("2026-11-20T07:29:00Z"), d))).toBe("2026-11-19T07:30:00.000Z");
  });

  it("weekdays: Monday to Friday only", () => {
    const d = digest({ frequency: "weekdays" });
    // Sunday 22 Nov and Saturday 21 Nov -> Friday 20 Nov.
    expect(iso(previousOccurrence(at("2026-11-22T12:00:00Z"), d))).toBe("2026-11-20T08:30:00.000Z");
    expect(iso(previousOccurrence(at("2026-11-21T12:00:00Z"), d))).toBe("2026-11-20T08:30:00.000Z");
    // Monday 23 Nov before 08:30 -> Friday 20 Nov; after -> Monday.
    expect(iso(previousOccurrence(at("2026-11-23T08:00:00Z"), d))).toBe("2026-11-20T08:30:00.000Z");
    expect(iso(previousOccurrence(at("2026-11-23T09:00:00Z"), d))).toBe("2026-11-23T08:30:00.000Z");
    // Thursday -> Thursday.
    expect(iso(previousOccurrence(at("2026-11-19T09:00:00Z"), d))).toBe("2026-11-19T08:30:00.000Z");
  });

  it("weekly: the chosen weekday (0 = Sunday)", () => {
    const sunday = digest({ frequency: "weekly", weekday: 0, time: "18:00" });
    expect(iso(previousOccurrence(at("2026-11-20T12:00:00Z"), sunday))).toBe("2026-11-15T18:00:00.000Z");
    expect(iso(previousOccurrence(at("2026-11-22T18:00:00Z"), sunday))).toBe("2026-11-22T18:00:00.000Z");
    // On the weekday, before the time: one week back.
    expect(iso(previousOccurrence(at("2026-11-22T17:59:00Z"), sunday))).toBe("2026-11-15T18:00:00.000Z");
    const friday = digest({ frequency: "weekly", weekday: 5 });
    expect(iso(previousOccurrence(at("2026-11-20T08:29:00Z"), friday))).toBe("2026-11-13T08:30:00.000Z");
  });

  it("weekly with the weekday of a local date that differs from the UTC date", () => {
    // Monday 07:00 in Sydney (AEDT, +11) = Sunday 20:00 UTC.
    const d = digest({ frequency: "weekly", weekday: 1, time: "07:00", timeZone: "Australia/Sydney" });
    expect(iso(previousOccurrence(at("2026-11-23T00:00:00Z"), d))).toBe("2026-11-22T20:00:00.000Z");
  });

  it("is null for a time that is not valid", () => {
    expect(previousOccurrence(at("2026-11-20T12:00:00Z"), digest({ time: "25:00" }))).toBeNull();
  });

  it("an invalid time zone falls back to UTC with no throw", () => {
    const d = digest({ timeZone: "Mars/Olympus_Mons" });
    expect(() => previousOccurrence(at("2026-11-20T12:00:00Z"), d)).not.toThrow();
    expect(iso(previousOccurrence(at("2026-11-20T12:00:00Z"), d))).toBe("2026-11-20T08:30:00.000Z");
  });
});

describe("previousOccurrence: daylight-saving changes", () => {
  // Each case: a daily digest at a local time that does not exist on the
  // spring-forward day (-> the next valid minute), and one that occurs two
  // times on the fall-back day (-> the first).
  const cases = [
    {
      zone: "America/New_York",
      gap: { day: "2026-03-08", time: "02:30", expected: "2026-03-08T07:00:00.000Z" }, // 03:00 EDT
      dayBeforeGap: "2026-03-07T07:30:00.000Z", // 02:30 EST
      overlap: { day: "2026-11-01", time: "01:30", first: "2026-11-01T05:30:00.000Z", second: "2026-11-01T06:30:00.000Z" },
    },
    {
      zone: "Europe/Berlin",
      gap: { day: "2026-03-29", time: "02:30", expected: "2026-03-29T01:00:00.000Z" }, // 03:00 CEST
      dayBeforeGap: "2026-03-28T01:30:00.000Z", // 02:30 CET
      overlap: { day: "2026-10-25", time: "02:30", first: "2026-10-25T00:30:00.000Z", second: "2026-10-25T01:30:00.000Z" },
    },
    {
      zone: "Australia/Sydney",
      gap: { day: "2026-10-04", time: "02:30", expected: "2026-10-03T16:00:00.000Z" }, // 03:00 AEDT
      dayBeforeGap: "2026-10-02T16:30:00.000Z", // 02:30 AEST
      overlap: { day: "2026-04-05", time: "02:30", first: "2026-04-04T15:30:00.000Z", second: "2026-04-04T16:30:00.000Z" },
    },
  ];

  for (const c of cases) {
    describe(c.zone, () => {
      it(`a local time in the spring-forward gap uses the next valid minute`, () => {
        const d = digest({ time: c.gap.time, timeZone: c.zone });
        const expected = at(c.gap.expected);
        expect(iso(previousOccurrence(expected + 3_600_000, d))).toBe(c.gap.expected);
        expect(iso(previousOccurrence(expected, d))).toBe(c.gap.expected);
        expect(iso(previousOccurrence(expected - 60_000, d))).toBe(c.dayBeforeGap);
        expect(zonedParts(expected, c.zone)).toMatchObject({ hour: 3, minute: 0 });
      });

      it(`a local time that occurs two times uses the first`, () => {
        const d = digest({ time: c.overlap.time, timeZone: c.zone });
        const first = at(c.overlap.first);
        const second = at(c.overlap.second);
        expect(iso(previousOccurrence(first + 15 * 60_000, d))).toBe(c.overlap.first);
        // After the second occurrence: still the first (one digest for the day).
        expect(iso(previousOccurrence(second + 15 * 60_000, d))).toBe(c.overlap.first);
        expect(zonedParts(first, c.zone)).toEqual(zonedParts(second, c.zone));
      });

      it(`the occurrence before the day after a change is that day`, () => {
        const d = digest({ time: c.gap.time, timeZone: c.zone });
        const next = previousOccurrence(at(c.gap.expected) + 30 * 3_600_000, d)!;
        expect(iso(occurrenceBefore(next, d))).toBe(c.gap.expected);
      });
    });
  }
});

describe("occurrenceBefore", () => {
  it("gives the scheduled instant before the given one", () => {
    const daily = digest();
    expect(iso(occurrenceBefore(at("2026-11-20T08:30:00Z"), daily))).toBe("2026-11-19T08:30:00.000Z");
    expect(iso(occurrenceBefore(at("2026-11-20T12:00:00Z"), daily))).toBe("2026-11-20T08:30:00.000Z");
  });

  it("skips the weekend for weekdays", () => {
    const d = digest({ frequency: "weekdays" });
    expect(iso(occurrenceBefore(at("2026-11-23T08:30:00Z"), d))).toBe("2026-11-20T08:30:00.000Z");
  });

  it("goes one week back for weekly", () => {
    const d = digest({ frequency: "weekly", weekday: 5 });
    expect(iso(occurrenceBefore(at("2026-11-20T08:30:00Z"), d))).toBe("2026-11-13T08:30:00.000Z");
  });

  it("counts an off schedule as daily, so that it always returns a number", () => {
    expect(iso(occurrenceBefore(at("2026-11-20T08:30:00Z"), digest({ frequency: "off" })))).toBe(
      "2026-11-19T08:30:00.000Z",
    );
  });
});

describe("isQuietHours", () => {
  const zone = "Europe/Berlin"; // CET (+1) in November
  const local = (hhmm: string) => at(`2026-11-20T${hhmm}:00+01:00`);

  it("is false when disabled", () => {
    expect(isQuietHours(local("20:00"), quiet("18:00", "08:00", false), zone)).toBe(false);
  });

  it("is false when start = end", () => {
    expect(isQuietHours(local("20:00"), quiet("20:00", "20:00"), zone)).toBe(false);
  });

  it("a period inside one day: start is inside, end is not", () => {
    const q = quiet("12:00", "14:00");
    expect(isQuietHours(local("11:59"), q, zone)).toBe(false);
    expect(isQuietHours(local("12:00"), q, zone)).toBe(true);
    expect(isQuietHours(local("13:59"), q, zone)).toBe(true);
    expect(isQuietHours(local("14:00"), q, zone)).toBe(false);
  });

  it("a period that crosses midnight", () => {
    const q = quiet("18:00", "08:00");
    expect(isQuietHours(local("17:59"), q, zone)).toBe(false);
    expect(isQuietHours(local("18:00"), q, zone)).toBe(true);
    expect(isQuietHours(local("23:59"), q, zone)).toBe(true);
    expect(isQuietHours(local("00:00"), q, zone)).toBe(true);
    expect(isQuietHours(local("07:59"), q, zone)).toBe(true);
    expect(isQuietHours(local("08:00"), q, zone)).toBe(false);
    expect(isQuietHours(local("12:00"), q, zone)).toBe(false);
  });

  it("uses the time zone (an invalid one falls back to UTC)", () => {
    const q = quiet("18:00", "08:00");
    // 17:30 UTC = 18:30 in Berlin.
    expect(isQuietHours(at("2026-11-20T17:30:00Z"), q, zone)).toBe(true);
    expect(isQuietHours(at("2026-11-20T17:30:00Z"), q, "UTC")).toBe(false);
    expect(() => isQuietHours(at("2026-11-20T17:30:00Z"), q, "Bad/Zone")).not.toThrow();
    expect(isQuietHours(at("2026-11-20T17:30:00Z"), q, "Bad/Zone")).toBe(false);
  });

  it("is false for a time that is not valid", () => {
    expect(isQuietHours(local("20:00"), quiet("18:00", "8"), zone)).toBe(false);
  });
});

describe("quietHoursEnd", () => {
  const zone = "Europe/Berlin";
  const local = (date: string, hhmm: string) => at(`${date}T${hhmm}:00+01:00`);

  it("is now when it is not quiet hours", () => {
    const now = local("2026-11-20", "12:00");
    expect(quietHoursEnd(now, quiet("18:00", "08:00"), zone)).toBe(now);
    expect(quietHoursEnd(now, quiet("18:00", "08:00", false), zone)).toBe(now);
    expect(quietHoursEnd(now, quiet("12:00", "12:00"), zone)).toBe(now);
  });

  it("a period that crosses midnight: before midnight -> the end on the next day", () => {
    expect(iso(quietHoursEnd(local("2026-11-20", "22:00"), quiet("18:00", "08:00"), zone))).toBe(
      "2026-11-21T07:00:00.000Z",
    );
  });

  it("a period that crosses midnight: after midnight -> the end on the same day", () => {
    expect(iso(quietHoursEnd(local("2026-11-21", "03:00"), quiet("18:00", "08:00"), zone))).toBe(
      "2026-11-21T07:00:00.000Z",
    );
  });

  it("a period inside one day", () => {
    expect(iso(quietHoursEnd(local("2026-11-20", "12:30"), quiet("12:00", "14:00"), zone))).toBe(
      "2026-11-20T13:00:00.000Z",
    );
  });

  it("an end time in the spring-forward gap uses the next valid minute", () => {
    // New York, 8 Mar 2026: 02:00-03:00 does not exist. Quiet 22:00-02:30.
    const now = at("2026-03-08T04:00:00Z"); // 23:00 EST on 7 Mar
    expect(iso(quietHoursEnd(now, quiet("22:00", "02:30"), "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
  });

  it("an end time that occurs two times uses the first", () => {
    // New York, 1 Nov 2026: 01:00-02:00 occurs two times. Quiet 22:00-01:30.
    const now = at("2026-11-01T03:00:00Z"); // 23:00 EDT on 31 Oct
    expect(iso(quietHoursEnd(now, quiet("22:00", "01:30"), "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });
});
