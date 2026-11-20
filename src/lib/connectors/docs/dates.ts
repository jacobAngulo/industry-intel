// Dates and versions in headings and date lines of documentation and changelog pages.
import { parseDate } from "@/lib/feeds";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** After a date: the end, or a separator, or a space (never a letter or a digit that continues the date). */
const END = "(?=$|[\\s,.;:·|—–\\-()\\[\\]/])";

const ISO_DATE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?${END}`, "i");
const SLASH_DATE = new RegExp(`^(\\d{4})/(\\d{1,2})/(\\d{1,2})${END}`);
const MONTH_DAY_YEAR = new RegExp(`^${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${END}`, "i");
const DAY_MONTH_YEAR = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})${END}`, "i");
const MONTH_YEAR = new RegExp(`^${MONTH},?\\s+(\\d{4})${END}`, "i");

function utc(year: number, month: number, day: number): number | undefined {
  if (year < 1990 || year > 2100 || month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const value = Date.UTC(year, month, day);
  // 31 February and similar days are not dates.
  return new Date(value).getUTCDate() === day ? value : undefined;
}

function monthIndex(name: string | undefined): number | undefined {
  if (name === undefined) return undefined;
  return MONTHS[name.toLowerCase().replace(/\.$/, "").slice(0, name.toLowerCase().startsWith("sept") ? 4 : 3)];
}

/**
 * The date at the start of a heading or a date line ("2026-11-19", "Nov 6, 2026 · Changelog",
 * "19 November 2026", "November 2026"), as epoch ms (UTC midnight), or undefined.
 */
export function leadingDate(text: string): number | undefined {
  const value = text.trim();
  if (value === "" || !/\d{4}/.test(value)) return undefined;
  let m = ISO_DATE.exec(value);
  if (m) {
    const full = parseDate(m[0].trim());
    return full ?? utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  m = SLASH_DATE.exec(value);
  if (m) return utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = MONTH_DAY_YEAR.exec(value);
  if (m) {
    const month = monthIndex(m[1]);
    return month === undefined ? undefined : utc(Number(m[3]), month, Number(m[2]));
  }
  m = DAY_MONTH_YEAR.exec(value);
  if (m) {
    const month = monthIndex(m[2]);
    return month === undefined ? undefined : utc(Number(m[3]), month, Number(m[1]));
  }
  m = MONTH_YEAR.exec(value);
  if (m) {
    const month = monthIndex(m[1]);
    return month === undefined ? undefined : utc(Number(m[2]), month, 1);
  }
  return undefined;
}

const VERSION_ONLY = /^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/i;
const VERSION_FIRST = /^(?:v\d+(?:\.\d+)*|\d+\.\d+\.\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.-]+)?(?=$|[\s:,(—–\-])/i;
const VERSION_WORD = /^(?:version|release|v)\s*\d+(?:\.\d+)*\b/i;
const VERSION_THEN_SEPARATOR = /^\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*(?:[:—–(]|-\s)/;
/**
 * "Claude Code 2.0.5", "Cursor v2.1": a short name, then a version with three parts or a "v", and
 * nothing after it. "Introducing Claude Haiku 5.5" (a model name) is not a version heading.
 */
const NAME_THEN_VERSION = /^[A-Za-z][\w.+-]*(?:\s+[A-Za-z][\w.+-]*){0,3}\s+(?:v\d+(?:\.\d+)*|\d+\.\d+\.\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * True when a heading names a version: "1.4.2", "v2.1", "Version 3", "2.1 — Agent improvements",
 * "Cursor v2.1". A numbered heading such as "1.2 Install" is not a version.
 */
export function isVersionHeading(text: string): boolean {
  const value = text.trim();
  if (value === "" || value.length > 120) return false;
  return (
    VERSION_ONLY.test(value) ||
    VERSION_FIRST.test(value) ||
    VERSION_WORD.test(value) ||
    VERSION_THEN_SEPARATOR.test(value) ||
    NAME_THEN_VERSION.test(value)
  );
}

/** The value of a `datetime` attribute as epoch ms, or undefined. */
export function datetimeValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parseDate(value) ?? leadingDate(value);
}
