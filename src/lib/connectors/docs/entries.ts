// The analysis of the sections of a page: which sections are dated, the mode of the page, and the
// changelog entries (specification §6.3, docs).
import { normalizeForHash, sha, type Section } from "@/lib/text";

import { datetimeValue, isVersionHeading, leadingDate } from "./dates";

export interface AnalyzedSection {
  section: Section;
  /** The text of the section's own heading (the last part of the path). */
  heading: string;
  /** The heading text is a date or a version: the section groups entries. */
  container: boolean;
  /** The heading is dated, the section has a datetime, or a short line at its start is a date. */
  dated: boolean;
  publishedAt?: number;
  /**
   * The nearest heading above this section (in its path) that is a date or a version. A date
   * heading with no text of its own has no section: its sub-sections still belong to it.
   */
  dateAncestor?: { depth: number; heading: string; publishedAt?: number };
}

export interface ChangelogEntry {
  /** 32 hex characters: the hash of the heading path (from the dated heading down) and the start of the entry. */
  id: string;
  /** The heading path from the dated heading down. */
  key: string;
  title: string;
  text: string;
  /** The lines of the entry, for the links. */
  lines: string[];
  publishedAt?: number;
}

/** Sections whose number reaches this make an "auto" page a changelog. */
export const AUTO_CHANGELOG_MIN_DATED = 3;
/** A titled entry needs at least this many characters apart from its date lines. */
const MIN_ENTRY_TEXT = 30;
/** A date line in the first blocks of a section is at most this long. */
const MAX_DATE_LINE = 60;
const PATH_SEPARATOR = " > ";

function lastSegment(path: string): string {
  const parts = path.split(PATH_SEPARATOR);
  return (parts[parts.length - 1] ?? path).replace(/ \(\d+\)$/, "").trim();
}

function isDateLine(block: string): boolean {
  return block.length <= MAX_DATE_LINE && leadingDate(block) !== undefined;
}

/** The date of the first short date line in the first 3 blocks of a section (any line of a block). */
function dateLineIn(blocks: string[]): number | undefined {
  for (const block of blocks.slice(0, 3)) {
    for (const line of block.split("\n")) {
      const value = line.trim();
      if (isDateLine(value)) return leadingDate(value);
    }
  }
  return undefined;
}

function findDateAncestor(path: string): AnalyzedSection["dateAncestor"] {
  const parts = path.split(PATH_SEPARATOR);
  for (let depth = parts.length - 2; depth >= 0; depth--) {
    const heading = (parts[depth] ?? "").replace(/ \(\d+\)$/, "").trim();
    const date = leadingDate(heading);
    if (date !== undefined || isVersionHeading(heading)) {
      return { depth, heading, ...(date !== undefined ? { publishedAt: date } : {}) };
    }
  }
  return undefined;
}

export function analyzeSections(sections: Section[]): AnalyzedSection[] {
  return sections.map((section) => {
    const heading = section.level === 0 ? "" : lastSegment(section.path);
    const headingDate = heading === "" ? undefined : leadingDate(heading);
    const version = heading !== "" && isVersionHeading(heading);
    const datetime = section.level === 0 ? undefined : datetimeValue(section.datetime);
    const lineDate = section.level === 0 ? undefined : dateLineIn(section.blocks);
    const container = headingDate !== undefined || version;
    const dated = container || datetime !== undefined || lineDate !== undefined;
    const out: AnalyzedSection = { section, heading, container, dated };
    const publishedAt = headingDate ?? datetime ?? lineDate;
    if (publishedAt !== undefined) out.publishedAt = publishedAt;
    const ancestor = section.level === 0 ? undefined : findDateAncestor(section.path);
    if (ancestor !== undefined) out.dateAncestor = ancestor;
    return out;
  });
}

/**
 * The resolved mode of an "auto" page: changelog when at least 3 sections are dated (a section
 * below a date or version heading counts too).
 */
export function detectMode(analyzed: AnalyzedSection[]): "changelog" | "page" {
  const dated = analyzed.filter((a) => a.dated || a.dateAncestor !== undefined).length;
  return dated >= AUTO_CHANGELOG_MIN_DATED ? "changelog" : "page";
}

function entryId(key: string, start: string): string {
  return sha(`${normalizeForHash(key)}\n${start}`).slice(0, 32);
}

function first80(text: string): string {
  return normalizeForHash(text).slice(0, 80);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}

/** The index after the last descendant of section i (the sections below its heading). */
function descendantsEnd(analyzed: AnalyzedSection[], i: number): number {
  const level = analyzed[i]!.section.level;
  let j = i + 1;
  while (j < analyzed.length && analyzed[j]!.section.level > level) j += 1;
  return j;
}

/** The heading path of section j from the heading of section i down. */
function relativePath(analyzed: AnalyzedSection[], i: number, j: number): string {
  const base = analyzed[i]!.section.path.split(PATH_SEPARATOR).length - 1;
  const parts = analyzed[j]!.section.path.split(PATH_SEPARATOR).slice(base);
  parts[0] = analyzed[i]!.heading;
  return parts.join(PATH_SEPARATOR);
}

/**
 * The entries of a changelog page, newest first.
 * - A section whose heading is a date or a version groups entries: each section below it is one
 *   entry; when there is none, each paragraph or list item of the section is one entry.
 * - Another dated section (a titled entry with a datetime or a date line, as on the Cursor
 *   changelog) is one entry with the sections below it. When a dated section is below it, it only
 *   wraps entries (a page heading, a featured block) and is no entry itself.
 * Entries with the same id count once. When every entry has a date, the newest date comes first;
 * else the page order counts.
 */
export function changelogEntries(analyzed: AnalyzedSection[]): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const consumed = new Set<number>();
  const push = (entry: Omit<ChangelogEntry, "lines">) => {
    entries.push({ ...entry, lines: entry.text.split("\n") });
  };

  for (let i = 0; i < analyzed.length; i++) {
    const a = analyzed[i]!;
    if (consumed.has(i) || a.section.level === 0) continue;
    if (!a.dated) {
      // Below a date or version heading that has no section of its own: one entry.
      const ancestor = a.dateAncestor;
      if (ancestor === undefined) continue;
      consumed.add(i);
      const parts = a.section.path.split(PATH_SEPARATOR).slice(ancestor.depth);
      parts[0] = ancestor.heading;
      parts[parts.length - 1] = a.heading;
      const key = parts.join(PATH_SEPARATOR);
      push({
        id: entryId(key, first80(a.section.text)),
        key,
        title: parts.join(" — "),
        text: a.section.text,
        ...(ancestor.publishedAt !== undefined ? { publishedAt: ancestor.publishedAt } : {}),
      });
      continue;
    }
    const end = descendantsEnd(analyzed, i);

    if (a.container) {
      let hasDatedChild = false;
      for (let j = i + 1; j < end; j++) if (analyzed[j]!.dated) hasDatedChild = true;
      if (hasDatedChild) continue; // the dated sections below are the entries
      consumed.add(i);
      if (end === i + 1) {
        for (const block of a.section.blocks) {
          if (block.trim() === "" || isDateLine(block)) continue;
          push({
            id: entryId(a.heading, first80(block)),
            key: a.heading,
            title: `${a.heading}: ${firstLine(block)}`,
            text: block,
            ...(a.publishedAt !== undefined ? { publishedAt: a.publishedAt } : {}),
          });
        }
        continue;
      }
      if (a.section.text.trim() !== "" && !a.section.blocks.every(isDateLine)) {
        push({
          id: entryId(a.heading, first80(a.section.text)),
          key: a.heading,
          title: a.heading,
          text: a.section.text,
          ...(a.publishedAt !== undefined ? { publishedAt: a.publishedAt } : {}),
        });
      }
      for (let j = i + 1; j < end; j++) {
        consumed.add(j);
        const child = analyzed[j]!;
        const key = relativePath(analyzed, i, j);
        push({
          id: entryId(key, first80(child.section.text)),
          key,
          title: key.split(PATH_SEPARATOR).join(" — "),
          text: child.section.text,
          ...(a.publishedAt !== undefined ? { publishedAt: a.publishedAt } : {}),
        });
      }
      continue;
    }

    // A titled section with a dated section below it wraps entries (a page heading, a featured
    // block): the dated sections below are the entries.
    let wrapsEntries = false;
    for (let j = i + 1; j < end; j++) if (analyzed[j]!.dated) wrapsEntries = true;
    if (wrapsEntries) continue;

    // A titled entry: its own text and the sections below it.
    consumed.add(i);
    const parts: string[] = [a.section.text];
    let substance = a.section.blocks.filter((b) => !isDateLine(b)).join(" ").trim().length;
    for (let j = i + 1; j < end; j++) {
      const child = analyzed[j]!;
      consumed.add(j);
      parts.push(`${child.heading}\n\n${child.section.text}`);
      substance += child.section.text.length;
    }
    if (substance < MIN_ENTRY_TEXT) continue;
    const text = parts.join("\n\n");
    const start = a.publishedAt !== undefined ? new Date(a.publishedAt).toISOString().slice(0, 10) : first80(text);
    push({
      id: entryId(a.heading, start),
      key: a.heading,
      title: a.heading,
      text,
      ...(a.publishedAt !== undefined ? { publishedAt: a.publishedAt } : {}),
    });
  }

  const unique: ChangelogEntry[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    unique.push(entry);
  }
  if (unique.length > 0 && unique.every((e) => e.publishedAt !== undefined)) {
    return unique
      .map((entry, index) => ({ entry, index }))
      .sort((x, y) => y.entry.publishedAt! - x.entry.publishedAt! || x.index - y.index)
      .map(({ entry }) => entry);
  }
  return unique;
}
