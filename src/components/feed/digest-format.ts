// Pure helpers of the digest pages (specification §4.4).

/** The localStorage key of the last visit of this browser to the digest list of a feed. */
export function digestsSeenKey(feedId: number): string {
  return `ii.digestsSeen.${feedId}`;
}

/** The stored time of the last visit, or null for a missing or bad value. */
export function parseDigestsSeen(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True when the latest digest is newer than the last visit (no visit yet = new). */
export function isDigestNew(digestCreatedAt: number, seenAt: number | null): boolean {
  return seenAt === null || digestCreatedAt > seenAt;
}

function formatter(timeZone: string, withYear: boolean): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  };
  if (withYear) options.year = "numeric";
  try {
    return new Intl.DateTimeFormat("en-GB", options);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
  }
}

function zoneOk(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * The period of a digest in the feed time zone:
 * "19 Nov 2026, 08:30 – 20 Nov 2026, 08:30 (Europe/Berlin)".
 */
export function formatPeriod(start: number, end: number, timeZone: string): string {
  const zone = zoneOk(timeZone);
  const f = formatter(zone, true);
  return `${f.format(new Date(start))} – ${f.format(new Date(end))} (${zone})`;
}
