// Pure helpers of the settings pages (no React, no database): tests run in node.
import type { SourceRow, SourceStatus } from "@/lib/services/types";
import type { AlertSettings, DigestFrequency, DigestSettings, SourceType } from "@/lib/types";

/** The re-judge estimate of one feed, from a settings action after a save. */
export interface RejudgeEstimate {
  feedId: number;
  feedName: string;
  /** The number of model calls (stories in the work list). */
  calls: number;
}

// ---------------------------------------------------------------------------
// Drafts of the delivery fields (number fields are text while a person types)
// ---------------------------------------------------------------------------

export interface DigestDraft {
  frequency: DigestFrequency;
  weekday: number;
  time: string;
  timeZone: string;
  maxStories: string;
}

export interface AlertDraft {
  enabled: boolean;
  rule: string;
  minRelevance: string;
}

export function digestToDraft(d: DigestSettings): DigestDraft {
  return { ...d, maxStories: String(d.maxStories) };
}

/** The digest of a draft, or the field errors (keys: `<prefix>.maxStories`). */
export function digestFromDraft(
  d: DigestDraft,
  prefix = "digest",
): { value: DigestSettings } | { errors: Record<string, string> } {
  const max = parseWholeNumber(d.maxStories, 1, 50);
  if ("error" in max) return { errors: { [`${prefix}.maxStories`]: max.error } };
  return { value: { frequency: d.frequency, weekday: d.weekday, time: d.time, timeZone: d.timeZone, maxStories: max.value } };
}

export function alertsToDraft(a: AlertSettings): AlertDraft {
  return { enabled: a.enabled, rule: a.rule, minRelevance: String(a.minRelevance) };
}

/** The alert settings of a draft, or the field errors (keys: `<prefix>.minRelevance`). */
export function alertsFromDraft(
  a: AlertDraft,
  prefix = "alerts",
): { value: AlertSettings } | { errors: Record<string, string> } {
  const min = parseWholeNumber(a.minRelevance, 0, 100);
  if ("error" in min) return { errors: { [`${prefix}.minRelevance`]: min.error } };
  return { value: { enabled: a.enabled, rule: a.rule.trim(), minRelevance: min.value } };
}

/** The order of the source groups (the same as SOURCE_TYPES of @/lib/types). */
const TYPE_ORDER: readonly SourceType[] = [
  "x_user",
  "x_search",
  "podcast",
  "blog",
  "github",
  "docs",
  "newsletter",
  "youtube",
  "community",
  "research",
  "web_search",
];

const MAX_PHRASES = 50;
const MAX_PHRASE_LENGTH = 300;

/**
 * Adds one exclusion phrase to a list. The phrase is trimmed. Returns the new
 * list, or an error for an empty phrase, a phrase that is too long, a
 * duplicate (no case difference), or a full list.
 */
export function addPhrase(list: readonly string[], raw: string): { list: string[] } | { error: string } {
  const phrase = raw.trim().replace(/\s+/g, " ");
  if (!phrase) return { error: "Enter a phrase." };
  if (phrase.length > MAX_PHRASE_LENGTH) return { error: `Use at most ${MAX_PHRASE_LENGTH} characters.` };
  if (list.some((p) => p.toLowerCase() === phrase.toLowerCase())) return { error: `"${phrase}" is in the list already.` };
  if (list.length >= MAX_PHRASES) return { error: `The list has ${MAX_PHRASES} phrases, the maximum.` };
  return { list: [...list, phrase] };
}

/** Removes the phrase at `index`. */
export function removePhrase(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

/** True when the two lists hold the same phrases in the same order (no case difference). */
export function samePhrases(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p.toLowerCase() === b[i]?.toLowerCase());
}

/** True when two texts differ after trimming (a judge-time change). */
export function textChanged(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

/** Parses the text of a number field: a whole number in [min, max], or an error. */
export function parseWholeNumber(raw: string, min: number, max: number): { value: number } | { error: string } {
  const message = `Enter a whole number from ${min} to ${max}.`;
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) return { error: message };
  const value = Number(t);
  if (!Number.isSafeInteger(value) || value < min || value > max) return { error: message };
  return { value };
}

// ---------------------------------------------------------------------------
// Brief format: "Use the shared default" (§4.8 Delivery)
// ---------------------------------------------------------------------------

/** The select value that means "use the shared default" (a null field). */
export const DEFAULT_CHOICE = "default";

/** A feed value (null = shared default) to the value of its select. */
export function toChoice(value: string | boolean | null): string {
  if (value === null) return DEFAULT_CHOICE;
  if (typeof value === "boolean") return value ? "on" : "off";
  return value;
}

/** The select value of a text setting back to the feed value (null = shared default). */
export function fromChoice<T extends string>(choice: string, allowed: readonly T[]): T | null {
  if (choice === DEFAULT_CHOICE) return null;
  return (allowed as readonly string[]).includes(choice) ? (choice as T) : null;
}

/** The select value of the suggested-actions setting back to the feed value. */
export function fromOnOffChoice(choice: string): boolean | null {
  if (choice === "on") return true;
  if (choice === "off") return false;
  return null;
}

/** The label of the "shared default" option, with the value of the default: "Use the shared default (Standard)". */
export function defaultOptionLabel(defaultLabel: string): string {
  return `Use the shared default (${defaultLabel})`;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** The time zone options: the current value first, then the others in their order, no duplicate. */
export function timeZoneOptions(current: string, all: readonly string[]): string[] {
  const rest = all.filter((zone) => zone !== current);
  return current ? [current, ...rest] : [...rest];
}

/** The IANA zones of the runtime (an empty list when the runtime has no Intl.supportedValuesOf). */
export function supportedTimeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const zones = intl.supportedValuesOf?.("timeZone") ?? [];
    return zones.includes("UTC") ? zones : [...zones, "UTC"];
  } catch {
    return ["UTC"];
  }
}

// ---------------------------------------------------------------------------
// Feed sources
// ---------------------------------------------------------------------------

export interface FeedSourceView {
  source: Pick<SourceRow, "id" | "type" | "name" | "status" | "statusDetail">;
  included: boolean;
}

/** Filters the rows by a search text (name, no case difference) and, optionally, to the included ones. */
export function filterFeedSources<R extends FeedSourceView>(rows: readonly R[], query: string, onlyIncluded: boolean): R[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => (!onlyIncluded || row.included) && (!q || row.source.name.toLowerCase().includes(q)));
}

/** Groups the rows by source type in the fixed type order. Empty groups are left out. */
export function groupByType<R extends FeedSourceView>(rows: readonly R[]): Array<{ type: SourceType; rows: R[] }> {
  return TYPE_ORDER.map((type) => ({ type, rows: rows.filter((row) => row.source.type === type) })).filter(
    (group) => group.rows.length > 0,
  );
}

/** The status badge of a source (§10.2): its text and tone. */
export function sourceStatusBadge(status: SourceStatus): { label: string; tone: "neutral" | "warning" | "alert" | "success" } {
  switch (status) {
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "needs_token":
      return { label: "Needs token", tone: "warning" };
    case "needs_setup":
      return { label: "Needs setup", tone: "warning" };
    case "failing":
      return { label: "Failing", tone: "alert" };
    case "waiting":
      return { label: "Waiting for first check", tone: "neutral" };
    default:
      return { label: "Active", tone: "success" };
  }
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

/** "1 model call" / "12 model calls". */
export function modelCalls(n: number): string {
  return `${n} model ${n === 1 ? "call" : "calls"}`;
}

/** The line after the include of a source (§7.7). */
export function queuedStoriesText(n: number): string {
  if (n <= 0) return "No recent story of this source waits for this feed.";
  return `${n} recent ${n === 1 ? "story is" : "stories are"} queued for this feed.`;
}

/** The re-judge progress line (§4.8): "Re-judging: 3 of 10 done, 1 failed". */
export function rejudgeProgressText(p: { status: "queued" | "running" | "done" | "failed"; total: number; done: number; failed: number }): string {
  const failed = p.failed > 0 ? `, ${p.failed} failed` : "";
  if (p.status === "queued" && p.total === 0) return "Re-judge queued. It starts when the worker is free.";
  if (p.status === "queued" || p.status === "running") return `Re-judging: ${p.done} of ${p.total} done${failed}.`;
  if (p.status === "failed") return `The last re-judge stopped: ${p.done} of ${p.total} done${failed}.`;
  return `The last re-judge is done: ${p.done} of ${p.total} stories${failed}.`;
}

/** The first field error for a key: the exact key, else the first key below it ("exclusions" → "exclusions.2"). */
export function errorFor(errors: Record<string, string> | undefined, key: string): string | null {
  if (!errors) return null;
  if (errors[key]) return errors[key];
  const prefix = `${key}.`;
  for (const [k, v] of Object.entries(errors)) if (k.startsWith(prefix)) return v;
  return null;
}

/**
 * The topics whose priority in `draft` differs from `saved` (a missing entry
 * is "normal"), for the topics of the list only. A save of the Topics section
 * sends only these, so that it never reverts another person's change of
 * another topic.
 */
export function changedTopicPriorities<P extends string>(
  saved: Readonly<Record<string, P>>,
  draft: Readonly<Record<string, P>>,
  topicIds: readonly number[],
  normal: P,
): Record<string, P> {
  const changed: Record<string, P> = {};
  for (const id of topicIds) {
    const key = String(id);
    const before = saved[key] ?? normal;
    const after = draft[key] ?? normal;
    if (before !== after) changed[key] = after;
  }
  return changed;
}

/** "1 failed check" or "3 failed checks in a row" (the status page, §4.10). */
export function failedChecksText(n: number): string {
  return n <= 1 ? "1 failed check" : `${n} failed checks in a row`;
}
