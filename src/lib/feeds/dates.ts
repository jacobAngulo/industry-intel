const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Offsets of the zone names of RFC 822 and of some other common names, in minutes. */
const ZONES: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
  akst: -540, akdt: -480, hst: -600,
  bst: 60, cet: 60, cest: 120, eet: 120, eest: 180, jst: 540, kst: 540, aest: 600, aedt: 660, nzst: 720, nzdt: 780,
};

const ISO =
  /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
// "Thu, 19 Nov 2026 19:53:30 +0000" (the day name, the seconds, and the zone are optional)
const RFC822 =
  /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,5}|[+-]\d{2}:?\d{2})?(?:\s*\([^)]*\))?$/;
// "November 19, 2026 19:53:30 GMT"
const MONTH_FIRST =
  /^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,5}|[+-]\d{2}:?\d{2})?$/;

function zoneMinutes(zone: string | undefined): number {
  if (zone === undefined || zone === "") return 0;
  const sign = zone.charAt(0);
  if (sign === "+" || sign === "-") {
    const digits = zone.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0");
    return sign === "-" ? -minutes : minutes;
  }
  // An unknown zone name counts as UTC.
  return ZONES[zone.toLowerCase()] ?? 0;
}

function build(
  year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number,
  zone: string | undefined,
): number | undefined {
  if (year < 1900 || year > 2200 || month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  if (hour > 24 || minute > 59 || second > 60) return undefined;
  const value = Date.UTC(year, month, day, hour, minute, second, ms) - zoneMinutes(zone) * 60_000;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a feed date (RFC 822, ISO 8601, or "Month day, year") as epoch milliseconds.
 * A date with no zone is UTC. A value that is not a valid date gives undefined; the function never
 * gives the current time.
 */
export function parseDate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "" || text.length > 80) return undefined;

  let m = ISO.exec(text);
  if (m !== null) {
    const fraction = m[7] !== undefined ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    return build(
      Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? "1"), Number(m[4] ?? "0"), Number(m[5] ?? "0"),
      Number(m[6] ?? "0"), fraction, m[8]?.toUpperCase() === "Z" ? undefined : m[8],
    );
  }
  m = RFC822.exec(text);
  if (m !== null) {
    const month = MONTHS[(m[2] ?? "").slice(0, 3).toLowerCase()];
    if (month === undefined) return undefined;
    let year = Number(m[3]);
    if ((m[3] ?? "").length <= 2) year += year < 70 ? 2000 : 1900;
    return build(year, month, Number(m[1]), Number(m[4] ?? "0"), Number(m[5] ?? "0"), Number(m[6] ?? "0"), 0, m[7]);
  }
  m = MONTH_FIRST.exec(text);
  if (m !== null) {
    const month = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
    if (month === undefined) return undefined;
    return build(Number(m[3]), month, Number(m[2]), Number(m[4] ?? "0"), Number(m[5] ?? "0"), Number(m[6] ?? "0"), 0, m[7]);
  }
  return undefined;
}

/** Reads a duration ("01:02:06", "62:06", or "2695") as seconds. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d{1,6}(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return undefined;
  let total = 0;
  for (const part of text.split(":")) total = total * 60 + Number(part);
  return Math.round(total);
}
