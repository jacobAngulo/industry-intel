// Pure text helpers of the story card, the story page, and the digest page.
// No React here, so the tests run in node.
import type { StoryHidden } from "@/lib/services/types";
import { HIDDEN_REASON_LABELS, type Confidence, type Depth, type Novelty } from "@/lib/types";

/** The address when it is an absolute http(s) URL, else null (§14: links only for http / https). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 4000) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The host of an http(s) URL without "www.", for a short link text. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A number with at most one decimal ("8", "6.7"). */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A rank part with its sign: "+8", "−6.7", "0". */
export function formatSigned(value: number): string {
  const text = formatScore(Math.abs(value));
  if (text === "0") return "0";
  return value > 0 ? `+${text}` : `−${text}`;
}

/** The decay line of §8.3: "20 h old, effective half-life 144 h: × 0.91". */
export function decayLine(decay: { ageHours: number; halfLifeHours: number; factor: number }): string {
  const age = Math.max(0, decay.ageHours);
  const ageText = age < 1 ? "less than 1 h old" : `${Math.round(age)} h old`;
  return `${ageText}, effective half-life ${formatScore(decay.halfLifeHours)} h: × ${decay.factor.toFixed(2)}`;
}

/** The source names of the meta line: the first `max`, then "+N". */
export function sourceNames<T extends { name: string }>(sources: readonly T[], max = 2): { shown: T[]; more: number } {
  return { shown: sources.slice(0, max), more: Math.max(0, sources.length - max) };
}

/** The hidden reason in words (§4.1 filtered view). */
export function hiddenReasonText(hidden: StoryHidden, exclusion: string | null): string {
  if (hidden === "my_vote") return "Your vote";
  if (hidden === "exclusion" && exclusion) {
    if (exclusion.trim().toLowerCase() === "source filter") return "Exclusion: the Ignore text of a source";
    return `Exclusion: “${exclusion}”`;
  }
  return HIDDEN_REASON_LABELS[hidden];
}

export const NOVELTY_LABELS: Record<Novelty, string> = { new: "New", update: "Update", repeat: "Repeat" };
export const DEPTH_LABELS: Record<Depth, string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };
export const CONFIDENCE_LABELS: Record<Confidence, string> = { high: "High", medium: "Medium", low: "Low" };

/** The three steps of the analysis progress line (§4.2). */
export const ANALYSIS_STEPS = ["Queued", "Reading the sources", "Writing"] as const;

/** The index of the current step: 0 queued, 1 reading, 2 writing. */
export function analysisStepIndex(status: "queued" | "running", stage: string | null): number {
  if (status === "queued") return 0;
  if (stage && /^writing/i.test(stage.trim())) return 2;
  return 1;
}

/** "1 story", "3 stories". */
export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The string entries of a value that should be a string list (stored model output can be broken). */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}
