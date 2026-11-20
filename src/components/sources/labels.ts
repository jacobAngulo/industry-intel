// Plain words for the source pages (specification §2, §4.5, §4.6, §10.2).
// Pure: no React, no Node. Server and client components can import it.
import type { BadgeTone } from "@/components/ui";
import type { ItemOutcome, SourceRow, SourceStatus } from "@/lib/services/types";
import { HIDDEN_REASON_LABELS, type HiddenReason } from "@/lib/types";

/** The status badge of §10.2. */
export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  active: "Active",
  waiting: "Waiting for first check",
  failing: "Failing",
  paused: "Paused",
  needs_token: "Needs token",
  needs_setup: "Needs setup",
};

export const SOURCE_STATUS_TONES: Record<SourceStatus, BadgeTone> = {
  active: "success",
  waiting: "accent",
  failing: "alert",
  paused: "neutral",
  needs_token: "warning",
  needs_setup: "warning",
};

type SourceNoteFacts = Pick<SourceRow, "status" | "statusDetail" | "hints">;

/**
 * The visible line under a source name in every layout (§13): for a failing
 * source the hint with the last error and the next try, otherwise the status
 * detail (for example the how-to of "Needs token"), otherwise the first hint.
 */
export function sourceNoteLine(row: SourceNoteFacts): string | null {
  const failing = row.status === "failing" ? row.hints.find((hint) => hint.startsWith("Failing since")) : undefined;
  return failing ?? row.statusDetail ?? row.hints[0] ?? null;
}

/**
 * Why a source of a feed brings no items (§13), in one line, or null when it
 * has no such problem: it needs a token or setup, it fails, it is paused, or
 * it has a status detail.
 */
export function sourceProblem(row: SourceNoteFacts): string | null {
  if (row.status === "paused") return "Paused: the worker does not check it.";
  if (row.status === "needs_token" || row.status === "needs_setup" || row.status === "failing") {
    return sourceNoteLine(row) ?? SOURCE_STATUS_LABELS[row.status];
  }
  return row.statusDetail;
}

/** The order of the status filter. */
export const SOURCE_STATUS_ORDER: readonly SourceStatus[] = [
  "active",
  "waiting",
  "failing",
  "paused",
  "needs_token",
  "needs_setup",
];

/** items.skip_reason in words (§7.2). */
export const SKIP_REASON_LABELS: Record<string, string> = {
  baseline: "first run of the search (kept as the starting point)",
  empty: "no title and no text",
  too_old: "too old when it arrived",
  first_run_cap: "older than the 8 newest items of the first check",
  no_feed: "the source was in no feed when it arrived",
};

/** "12 %" or "–" when nothing was judged. */
export function formatSignalRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "–";
  const percent = rate * 100;
  if (percent > 0 && percent < 1) return "< 1 %";
  return `${Math.round(percent)} %`;
}

/** "Every 2 h", "Every 30 min", "Every day". */
export function formatInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "–";
  if (minutes % 10080 === 0) return minutes === 10080 ? "Every week" : `Every ${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} h`;
  return `Every ${minutes} min`;
}

/** Check intervals that the forms offer (minutes). */
export const INTERVAL_PRESETS: readonly number[] = [15, 30, 60, 120, 180, 360, 720, 1440, 10080];

/** The options of an interval select: the presets, the default of the type, and the current value. */
export function intervalOptions(current: number, typeDefault: number): Array<{ value: string; label: string }> {
  const values = new Set<number>(INTERVAL_PRESETS);
  values.add(typeDefault);
  if (Number.isInteger(current) && current >= 5 && current <= 10080) values.add(current);
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => ({
      value: String(value),
      label: `${formatInterval(value)}${value === typeDefault ? " (default for this type)" : ""}`,
    }));
}

export interface OutcomeText {
  text: string;
  tone: "shown" | "filtered" | "waiting" | "skipped" | "failed" | "none";
}

/** The outcome of one item in one feed (§4.6 "Recent items"). */
export function itemOutcomeText(item: ItemOutcome, feed: ItemOutcome["perFeed"][number]): OutcomeText {
  if (item.judgeStatus === "pending") return { text: "Waiting for the model", tone: "waiting" };
  if (item.judgeStatus === "skipped") {
    const reason = item.skipReason ? (SKIP_REASON_LABELS[item.skipReason] ?? item.skipReason) : "no reason given";
    return { text: `Skipped: ${reason}`, tone: "skipped" };
  }
  if (item.judgeStatus === "failed") return { text: "Failed: the model could not judge it", tone: "failed" };
  if (feed.relevance === null) return { text: "Not judged for this feed", tone: "none" };
  if (feed.hidden === null) return { text: `Relevance ${feed.relevance} · shown`, tone: "shown" };
  return { text: `Relevance ${feed.relevance} · filtered: ${hiddenReasonText(feed.hidden)}`, tone: "filtered" };
}

/** A hidden reason in words (lower case after the first word). */
export function hiddenReasonText(reason: HiddenReason): string {
  const label = HIDDEN_REASON_LABELS[reason] ?? reason;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Only http and https addresses become links (§14). */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** "Agentic Development, Industry Radar" or "No feed". */
export function joinNames(names: string[], empty = "none"): string {
  if (names.length === 0) return empty;
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
