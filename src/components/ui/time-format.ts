// Pure time formatting for the UI. No React, no Next.js: tests run in node.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A short relative time: "just now", "5 min ago", "3 h ago", "2 d ago",
 * "in 10 min", "in 4 h". After 14 days (either way) a date: "19 Nov" or
 * "19 Nov 2025" (other year). The date is in UTC, so the result is the same
 * on the server and in the browser.
 */
export function formatRelative(at: number, now: number): string {
  const diff = now - at;
  const abs = Math.abs(diff);
  const future = diff < 0;
  if (abs < MINUTE) return future ? "in less than a minute" : "just now";
  if (abs < HOUR) {
    const m = Math.floor(abs / MINUTE);
    return future ? `in ${m} min` : `${m} min ago`;
  }
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    return future ? `in ${h} h` : `${h} h ago`;
  }
  if (abs < 14 * DAY) {
    const d = Math.floor(abs / DAY);
    return future ? `in ${d} d` : `${d} d ago`;
  }
  return formatDateUtc(at, now);
}

/** "19 Nov" (same UTC year as `now`) or "19 Nov 2025". */
export function formatDateUtc(at: number, now?: number): string {
  const d = new Date(at);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (now !== undefined && new Date(now).getUTCFullYear() === d.getUTCFullYear()) return base;
  return `${base} ${d.getUTCFullYear()}`;
}

/** "2026-11-19 14:05 UTC": a stable absolute time (the same text on the server and the client). */
export function formatAbsoluteUtc(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The absolute time in a time zone, for a tooltip: "Thu, 19 Nov 2026, 14:05 (Europe/Berlin)".
 * Without a time zone the runtime zone is used (the browser zone on the client).
 */
export function formatAbsolute(at: number, timeZone?: string): string {
  try {
    const text = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(at));
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? `${text} (${zone})` : text;
  } catch {
    return formatAbsoluteUtc(at);
  }
}

/** "HH:MM" in a time zone (for banner text such as "Judging starts again at 14:30"). */
export function formatClock(at: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(
      new Date(at),
    );
  } catch {
    return new Date(at).toISOString().slice(11, 16);
  }
}
