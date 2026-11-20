// The schedule functions of specification §9.2: pure functions over Intl (no
// Temporal), for any IANA time zone. An unknown time zone falls back to UTC
// and never throws.
//
//   zonedParts(instant, tz)          the local date and time of an instant
//   previousOccurrence(now, digest)  the latest scheduled digest instant <= now
//   occurrenceBefore(instant, d)     the scheduled instant before an instant
//   isQuietHours(now, quiet, tz)     is `now` inside the quiet hours?
//   quietHoursEnd(now, quiet, tz)    the instant when the current quiet period ends
//
// Daylight-saving rules: a local time that does not exist on a day (spring
// forward) uses the next valid minute (02:30 in a gap 02:00-03:00 -> 03:00).
// A local time that occurs two times (fall back) uses the first one.
import type { DigestSettings, QuietHours } from "@/lib/types";

export interface ZonedParts {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
  /** 0..23 */
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday (the same numbers as DigestSettings.weekday). */
  weekday: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// --- time zones ---------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function makeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
}

/** The formatter of a time zone; the UTC formatter when the name is not valid. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const key = typeof timeZone === "string" && timeZone.trim() !== "" ? timeZone.trim() : "UTC";
  let formatter = formatters.get(key);
  if (!formatter) {
    try {
      formatter = makeFormatter(key);
    } catch {
      formatter = formatters.get("UTC") ?? makeFormatter("UTC");
    }
    formatters.set(key, formatter);
  }
  return formatter;
}

type FullParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function fullParts(instant: number, timeZone: string): FullParts {
  const out: FullParts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type in out) out[part.type as keyof FullParts] = Number(part.value);
  }
  // Some runtimes write midnight as hour 24.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** The local wall time of an instant, written as if it were a UTC instant (milliseconds). */
function localEpoch(instant: number, timeZone: string): number {
  const p = fullParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The local date and time of an instant in the time zone (UTC when the name is not valid). */
export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const p = fullParts(instant, timeZone);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, weekday };
}

/**
 * The instant of a local date and time in a time zone. `local` is the wall
 * time written as a UTC instant (Date.UTC(year, month - 1, day, hour, minute)).
 * A wall time that occurs two times gives the first instant; a wall time
 * that does not exist gives the first instant after the gap (the next valid
 * minute).
 */
function instantOfLocal(local: number, timeZone: string): number {
  // The offsets near the wall time. A transition changes the offset by at
  // most a few hours, so the offsets one day before and after are enough.
  const offsets = new Set<number>();
  for (const probe of [local - DAY_MS, local, local + DAY_MS]) {
    offsets.add(localEpoch(probe, timeZone) - probe);
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = local - offset;
    if (localEpoch(candidate, timeZone) === local) matches.push(candidate);
  }
  if (matches.length > 0) return Math.min(...matches);

  // A gap: find the first instant whose wall time is not before `local`.
  // Search on whole minutes between the two candidate instants.
  const sorted = [...offsets].sort((a, b) => a - b);
  let low = Math.floor((local - sorted[sorted.length - 1]! - HOUR_MS) / MINUTE_MS); // wall time < local
  let high = Math.ceil((local - sorted[0]! + HOUR_MS) / MINUTE_MS); // wall time >= local
  if (localEpoch(high * MINUTE_MS, timeZone) < local) return local - sorted[0]!; // no gap found: be safe
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localEpoch(middle * MINUTE_MS, timeZone) >= local) high = middle;
    else low = middle;
  }
  return high * MINUTE_MS;
}

// --- clock times --------------------------------------------------------------

/** "HH:MM" -> minutes after midnight, or null when the text is not a valid time. */
function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof text === "string" ? text.trim() : "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** The local date of an instant as a UTC midnight (Date.UTC(year, month - 1, day)). */
function localDate(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day);
}

// --- digests --------------------------------------------------------------------

function isScheduledDay(date: number, digest: DigestSettings): boolean {
  const weekday = new Date(date).getUTCDay();
  switch (digest.frequency) {
    case "daily":
      return true;
    case "weekdays":
      return weekday >= 1 && weekday <= 5;
    case "weekly":
      return weekday === digest.weekday;
    default:
      return false;
  }
}

/** The latest scheduled instant <= `now` for a frequency that is not off. */
function latestAtOrBefore(now: number, digest: DigestSettings): number | null {
  const minutes = parseClock(digest.time);
  if (minutes === null) return null;
  const today = localDate(now, digest.timeZone);
  // Today and the 8 days before: enough for a weekly schedule whose time
  // today is still to come.
  for (let back = 0; back <= 8; back += 1) {
    const date = today - back * DAY_MS;
    if (!isScheduledDay(date, digest)) continue;
    const instant = instantOfLocal(date + minutes * MINUTE_MS, digest.timeZone);
    if (instant <= now) return instant;
  }
  return null;
}

/** The latest scheduled instant <= now; null when the digest is off (or the time is not valid). */
export function previousOccurrence(now: number, digest: DigestSettings): number | null {
  if (digest.frequency === "off") return null;
  return latestAtOrBefore(now, digest);
}

/**
 * The scheduled instant before the given one. With frequency `off` (or a
 * time that is not valid) the schedule counts as daily (at 00:00 when the
 * time is not valid), so that the function always returns a number.
 */
export function occurrenceBefore(instant: number, digest: DigestSettings): number {
  const schedule: DigestSettings = {
    ...digest,
    frequency: digest.frequency === "off" ? "daily" : digest.frequency,
    time: parseClock(digest.time) === null ? "00:00" : digest.time,
  };
  return latestAtOrBefore(instant - 1, schedule) ?? instant - DAY_MS;
}

// --- quiet hours ----------------------------------------------------------------

type QuietWindow = { start: number; end: number };

function quietWindow(quiet: QuietHours): QuietWindow | null {
  if (!quiet.enabled) return null;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

function insideWindow(minuteOfDay: number, window: QuietWindow): boolean {
  if (window.start < window.end) return minuteOfDay >= window.start && minuteOfDay < window.end;
  // The period crosses midnight.
  return minuteOfDay >= window.start || minuteOfDay < window.end;
}

/** start = end or disabled -> false. The start minute is inside; the end minute is not. */
export function isQuietHours(now: number, quiet: QuietHours, timeZone: string): boolean {
  const window = quietWindow(quiet);
  if (!window) return false;
  const p = zonedParts(now, timeZone);
  return insideWindow(p.hour * 60 + p.minute, window);
}

/** The instant when the current quiet period ends; `now` when it is not quiet hours now. */
export function quietHoursEnd(now: number, quiet: QuietHours, timeZone: string): number {
  const window = quietWindow(quiet);
  if (!window) return now;
  const p = zonedParts(now, timeZone);
  const minuteOfDay = p.hour * 60 + p.minute;
  if (!insideWindow(minuteOfDay, window)) return now;
  const today = Date.UTC(p.year, p.month - 1, p.day);
  // Before the end on the same local date, or (a period that crosses
  // midnight, after its start) the end on the next local date.
  const endDate = minuteOfDay < window.end ? today : today + DAY_MS;
  const end = instantOfLocal(endDate + window.end * MINUTE_MS, timeZone);
  return end > now ? end : now;
}
