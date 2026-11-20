// The pure rules of the add-source flow (specification §4.7). No React, no
// Node: the client wizard and the tests import them.
import type { Candidate } from "@/lib/connectors/types";
import type { PreviewResult, QualifyResult } from "@/lib/services/types";
import { SOURCE_TYPES, type SourceType } from "@/lib/types";

/** §4.7 step 1: at most 10 entries. */
export const MAX_ENTRIES = 10;
/** The longest entry that the server takes. */
export const MAX_ENTRY_CHARS = 2000;
/** The longest `entries` query value that the page reads. */
export const MAX_ENTRIES_PARAM_CHARS = 20_000;

const HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;

/**
 * The entries of the text area: one for each line; a line of comma-separated
 * handles ("@a, @b" or, with the X user type, "a, b") gives one entry for each
 * handle. Empty lines go; duplicates (no case difference) go.
 */
export function splitEntries(text: string, forcedType?: SourceType | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const entry = value.trim();
    if (!entry) return;
    const key = entry.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes(",") && !trimmed.includes("://")) {
      const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
      const handles = parts.length > 1 && parts.every((part) => HANDLE.test(part));
      const handleIntent = parts.some((part) => part.startsWith("@")) || forcedType === "x_user";
      if (handles && handleIntent) {
        parts.forEach(push);
        continue;
      }
    }
    push(trimmed);
  }
  return out;
}

/** The value of the `entries` query parameter as the text of the text area (one entry for each line). */
export function entriesFromParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join("\n") : (value ?? "");
  return raw.slice(0, MAX_ENTRIES_PARAM_CHARS).replace(/\r\n/g, "\n").trim();
}

/** A source type from a query parameter, or null. */
export function typeFromParam(value: string | string[] | undefined): SourceType | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && (SOURCE_TYPES as readonly string[]).includes(raw) ? (raw as SourceType) : null;
}

/** The address of step 1 with the type forced and the entries filled in. */
export function wizardHref(opts: { type?: SourceType | null; entries?: string[]; feed?: string | null }): string {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.feed) params.set("feed", opts.feed);
  if (opts.entries && opts.entries.length > 0) params.set("entries", opts.entries.join("\n"));
  const query = params.toString();
  return query ? `/sources/new?${query}` : "/sources/new";
}

/** A candidate as the wizard keeps it: the server marks a candidate whose source is in the directory. */
export interface WizardCandidate extends Candidate {
  existing: { id: number; name: string } | null;
}

export interface ResolvedEntry {
  input: string;
  candidates: WizardCandidate[];
  error?: string;
}

/**
 * The types that every resolved entry has a candidate of (entries with no
 * candidate do not count), the most likely type first (the sum of the best
 * confidence of each entry).
 */
export function commonTypes(entries: ResolvedEntry[]): SourceType[] {
  const resolved = entries.filter((entry) => entry.candidates.length > 0);
  if (resolved.length === 0) return [];
  const score = new Map<SourceType, number>();
  for (const type of SOURCE_TYPES) {
    let total = 0;
    let everywhere = true;
    for (const entry of resolved) {
      const best = bestCandidate(entry, type);
      if (!best) {
        everywhere = false;
        break;
      }
      total += best.confidence;
    }
    if (everywhere) score.set(type, total);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
}

/** The candidate of the type with the highest confidence, or null. */
export function bestCandidate(entry: ResolvedEntry, type: SourceType): WizardCandidate | null {
  let best: WizardCandidate | null = null;
  for (const candidate of entry.candidates) {
    if (candidate.type !== type) continue;
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}

export type MultiPlan =
  | { kind: "no_common_type"; unresolved: string[] }
  | { kind: "choose_type"; types: SourceType[]; unresolved: string[] }
  | {
      kind: "ready";
      type: SourceType;
      /** Another common type that the person can choose instead. */
      otherTypes: SourceType[];
      picks: Array<{ input: string; candidate: WizardCandidate }>;
      /** Entries whose source is in the directory: they are not added again. */
      existing: Array<{ input: string; source: { id: number; name: string } }>;
      unresolved: string[];
    };

/**
 * The rules for several entries (§4.7 step 1): all must resolve to one common
 * type; the best candidate of that type for each entry; the entries that did
 * not resolve are listed; with more than one common type the person picks
 * (`chosen`). A forced type is the only common type that counts.
 */
export function planEntries(entries: ResolvedEntry[], opts: { forcedType?: SourceType | null; chosen?: SourceType | null } = {}): MultiPlan {
  const unresolved = entries.filter((entry) => entry.candidates.length === 0).map((entry) => entry.input);
  let types = commonTypes(entries);
  if (opts.forcedType) types = types.filter((type) => type === opts.forcedType);
  if (types.length === 0) return { kind: "no_common_type", unresolved };
  let type: SourceType | null = null;
  if (types.length === 1) type = types[0]!;
  else if (opts.chosen && types.includes(opts.chosen)) type = opts.chosen;
  if (type === null) return { kind: "choose_type", types, unresolved };

  const picks: Array<{ input: string; candidate: WizardCandidate }> = [];
  const existing: Array<{ input: string; source: { id: number; name: string } }> = [];
  for (const entry of entries) {
    const candidate = bestCandidate(entry, type);
    if (!candidate) continue;
    if (candidate.existing) existing.push({ input: entry.input, source: candidate.existing });
    else picks.push({ input: entry.input, candidate });
  }
  return { kind: "ready", type, otherTypes: types.filter((t) => t !== type), picks, existing, unresolved };
}

/**
 * The field errors of one config from the errors of a Server Action, without
 * the prefix: { "entries.0.config.feedUrl": "…" } with the prefix
 * "entries.0.config" gives { feedUrl: "…" }. An error on the whole config goes to "_config".
 */
export function errorsAt(fieldErrors: Record<string, string> | undefined, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fieldErrors) return out;
  for (const [key, message] of Object.entries(fieldErrors)) {
    if (key === prefix) out._config = message;
    else if (key.startsWith(`${prefix}.`)) {
      const rest = key.slice(prefix.length + 1);
      const field = rest.split(".")[0]!;
      if (!(field in out)) out[field] = message;
    }
  }
  return out;
}

/** The source name of the qualify check for several entries (at most 120 characters). */
export function combinedSourceName(names: string[]): string {
  const text = names.length === 1 ? names[0]! : names.join(", ");
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** True when two values have the same JSON (for "the preview is still current"). */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The result of the preview step (Server Action previewEntriesAction). */
export interface PreviewStep {
  /** The configs with the schema defaults (for example "@name" becomes "name"). */
  configs: unknown[];
  preview: PreviewResult;
}

/** The result of the add step (Server Action createSourcesAction). */
export interface CreateStep {
  created: Array<{ id: number; name: string }>;
  skipped: Array<{ name: string; reason: string }>;
  queuedStories: number;
}

/**
 * The owner to send at "Add source" (§4.7: the owner is prefilled with the
 * display name). When the person did not edit the Owner field and it is
 * empty, the name that the name gate saved just before is the owner.
 */
export function ownerForCreate(owner: string, touched: boolean, name: string | null): string {
  if (!touched && !owner.trim() && name) return name;
  return owner;
}

/** The stored model check of the preview step. */
export interface QualifyState {
  key: string;
  result: QualifyResult | null;
  error: string | null;
}

/**
 * True when the preview step can show the stored model check again: the same
 * input and a successful check. An unavailable model or an error runs the check again.
 */
export function canReuseQualify(qualify: QualifyState | null, key: string): boolean {
  return qualify !== null && qualify.key === key && qualify.result?.available === true;
}
