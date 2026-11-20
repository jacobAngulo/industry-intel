// The clock of the app. All code reads the time from nowMs(), so that a test
// can set it.

let nowForTests: (() => number) | null = null;

/** The current time in UTC epoch milliseconds. */
export function nowMs(): number {
  return nowForTests ? nowForTests() : Date.now();
}

/**
 * Tests: makes nowMs() return the value of `fn` (or the fixed number).
 * `null` gives the real clock back.
 */
export function setNowForTests(fn: (() => number) | number | null): void {
  if (fn === null) nowForTests = null;
  else if (typeof fn === "number") nowForTests = () => fn;
  else nowForTests = fn;
}

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The UTC day of an instant as 'YYYY-MM-DD' (the key of usage_daily). */
export function utcDay(ms: number = nowMs()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first instant of the next UTC day after `ms`. */
export function nextUtcMidnight(ms: number = nowMs()): number {
  return (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
}
