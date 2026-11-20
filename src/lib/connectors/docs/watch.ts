// The page watch of the docs connector (specification §6.3): the snapshot in the cursor, and the
// items of the changelog mode and of the page mode.
import { extractLinks, normalizeForHash, sha, truncate, type Section } from "@/lib/text";

import { RAW_ITEM_MAX_LINKS, RAW_ITEM_MAX_TEXT, type RawItem } from "../types";
import { changedParts, contentHash, isMinorEdit, lineKeysOf } from "./diff";
import type { ChangelogEntry } from "./entries";
import { linksForLines } from "./page";

export interface DocsSnapshotSection {
  /**
   * Page mode: the heading path of the section. Changelog mode: the heading path of the entry,
   * then " #" and the entry id.
   */
  path: string;
  /** The hash of the normalized text (cosmetic edits give the same hash). */
  hash: string;
  /** The text, at most 4000 characters. */
  text: string;
  /**
   * Only for a text longer than 4000 characters: the short hashes of all its lines (capped), so that
   * a later poll knows the lines after the cut. Snapshots from before this field have none.
   */
  lineKeys?: string[];
}

/** The cursor of a docs source. */
export interface DocsCursor {
  etag?: string;
  lastModified?: string;
  /** The resolved mode. */
  mode: "changelog" | "page";
  /** At most 300. */
  sections: DocsSnapshotSection[];
  /**
   * Changelog mode: the ids of the entries that the source has seen (at most 500). Only the first
   * 500 entries of the page (newest first) count, so an entry after them is never new.
   */
  seenEntryIds: string[];
}

export const MAX_SECTIONS = 300;
export const MAX_SECTION_TEXT = 4000;
export const MAX_ENTRY_IDS = 500;
/** The first snapshot of a changelog emits this many of the newest entries. */
export const BASELINE_ENTRIES = 3;
/** More changed sections than this in one poll give one "Large revision" item. */
export const LARGE_REVISION_SECTIONS = 8;
export const PREVIEW_ITEMS = 5;
export const PAGE_PREVIEW_NOTE = "This page has no dated entries. New and changed sections become items.";

export interface WatchPage {
  url: string;
  title: string;
  linksByText: Map<string, string>;
  ignoreMinorEdits: boolean;
}

/** One snapshot section: the hash of the full text, the cut text, and the line keys of a long text. */
function snapshotSection(path: string, text: string): DocsSnapshotSection {
  const section: DocsSnapshotSection = { path, hash: contentHash(text), text: truncate(text, MAX_SECTION_TEXT) };
  if (text.length > MAX_SECTION_TEXT) section.lineKeys = lineKeysOf(text);
  return section;
}

/**
 * True when the minor-edit rule can compare the two versions: both texts are whole in the snapshot.
 * A cut text hides the changes after the cut.
 */
function comparable(old: DocsSnapshotSection, text: string): boolean {
  return text.length <= MAX_SECTION_TEXT && old.lineKeys === undefined;
}

function id32(text: string): string {
  return sha(text).slice(0, 32);
}

function linksFor(page: WatchPage, text: string): string[] | undefined {
  const lines = text.split("\n");
  const links = linksForLines(lines, page.linksByText, RAW_ITEM_MAX_LINKS);
  for (const link of extractLinks(text)) {
    if (links.length >= RAW_ITEM_MAX_LINKS) break;
    if (!links.includes(link)) links.push(link);
  }
  return links.length > 0 ? links : undefined;
}

function finish(item: RawItem, page: WatchPage, linkText: string, publishedAt?: number): RawItem {
  const links = linksFor(page, linkText);
  if (links) item.links = links;
  if (publishedAt !== undefined) item.publishedAt = publishedAt;
  return item;
}

/** The text of an item about a change: the new and changed parts, else the removed lines. */
function changeText(old: DocsSnapshotSection | undefined, blocks: string[], fallback: string): string {
  const { added, removed } = changedParts(old?.text ?? "", blocks, old?.lineKeys);
  if (added.length > 0) return added.join("\n\n");
  if (removed.length > 0) return `Removed:\n${removed.map((line) => `- ${line}`).join("\n")}`;
  return fallback;
}

function blocksOf(text: string): string[] {
  return text.split(/\n{2,}/).filter((block) => block.trim() !== "");
}

// ---------------------------------------------------------------------------------------------
// Changelog mode

/**
 * The address of an entry: the link of its heading (as on the Cursor changelog and the Anthropic
 * news list, where the heading links to the article), else the link of its first line, else the page.
 */
function entryUrl(entry: ChangelogEntry, page: WatchPage): string {
  const parts = entry.key.split(" > ");
  const heading = parts[parts.length - 1] ?? "";
  const firstLine = entry.text.split("\n").find((line) => line.trim() !== "") ?? "";
  for (const text of [heading, firstLine.replace(/^\s*-\s+/, "")]) {
    const link = page.linksByText.get(normalizeForHash(text));
    if (link !== undefined) return link;
  }
  return page.url;
}

export function entryPath(entry: ChangelogEntry): string {
  return `${entry.key} #${entry.id}`;
}

export function entryIdOfPath(path: string): string {
  const at = path.lastIndexOf(" #");
  return at < 0 ? path : path.slice(at + 2);
}

function newEntryItem(entry: ChangelogEntry, page: WatchPage, extraMeta: Record<string, unknown> = {}): RawItem {
  const url = entryUrl(entry, page);
  const item = finish(
    {
      externalId: entry.id,
      url,
      title: truncate(entry.title, 300),
      kind: "doc_change",
      text: truncate(entry.text, RAW_ITEM_MAX_TEXT),
      meta: { change: "new_entry", path: entry.key, pageTitle: page.title, ...extraMeta },
    },
    page,
    `${entry.title}\n${entry.text}`,
    entry.publishedAt,
  );
  return withLink(item, url, page);
}

/** Puts the entry address first in the links when it is not the page itself. */
function withLink(item: RawItem, url: string, page: WatchPage): RawItem {
  if (url === page.url) return item;
  const links = [url, ...(item.links ?? []).filter((link) => link !== url)].slice(0, RAW_ITEM_MAX_LINKS);
  item.links = links;
  return item;
}

function snapshotOfEntries(entries: ChangelogEntry[]): DocsSnapshotSection[] {
  return entries.slice(0, MAX_SECTIONS).map((entry) => snapshotSection(entryPath(entry), entry.text));
}

/** Preview of a changelog: the newest entries. */
export function previewChangelog(entries: ChangelogEntry[], page: WatchPage, limit: number): RawItem[] {
  return entries.slice(0, Math.min(limit, PREVIEW_ITEMS)).map((entry) => newEntryItem(entry, page));
}

export function pollChangelog(args: {
  entries: ChangelogEntry[];
  previous: DocsCursor | null;
  page: WatchPage;
  limit: number;
}): { items: RawItem[]; sections: DocsSnapshotSection[]; seenEntryIds: string[] } {
  const { page, previous, limit } = args;
  // The cursor remembers at most MAX_ENTRY_IDS ids: only the newest entries count, so an old entry
  // after them (that the cap dropped from seenEntryIds) never comes back as new.
  const entries = args.entries.slice(0, MAX_ENTRY_IDS);
  const ids = entries.map((entry) => entry.id);

  if (previous === null) {
    // The first snapshot is a baseline: only the newest entries become items.
    const items = entries.slice(0, Math.min(BASELINE_ENTRIES, limit)).map((entry) => newEntryItem(entry, page));
    return { items, sections: snapshotOfEntries(entries), seenEntryIds: ids.slice(0, MAX_ENTRY_IDS) };
  }

  const known = new Map(previous.sections.map((s) => [entryIdOfPath(s.path), s]));
  const seen = new Set(previous.seenEntryIds);
  const items: RawItem[] = [];
  const sections: DocsSnapshotSection[] = [];
  for (const entry of entries) {
    const old = known.get(entry.id);
    const snap = snapshotSection(entryPath(entry), entry.text);
    const { hash, text: stored } = snap;
    if (old === undefined) {
      if (!seen.has(entry.id)) items.push(newEntryItem(entry, page));
      sections.push(snap);
      continue;
    }
    if (old.hash === hash) {
      sections.push(snap);
      continue;
    }
    if (page.ignoreMinorEdits && comparable(old, entry.text) && isMinorEdit(old.text, stored)) {
      // Keep the old version, so that small edits add up until they count.
      sections.push({ ...old, path: entryPath(entry) });
      continue;
    }
    const text = changeText(old, blocksOf(entry.text), entry.text);
    const url = entryUrl(entry, page);
    items.push(withLink(
      finish(
        {
          externalId: `${entry.id}:${hash.slice(0, 16)}`,
          url,
          title: truncate(`Updated: ${entry.title}`, 300),
          kind: "doc_change",
          text: truncate(text, RAW_ITEM_MAX_TEXT),
          meta: { change: "changed_entry", path: entry.key, pageTitle: page.title, before: old.text, after: stored },
        },
        page,
        text,
        entry.publishedAt,
      ),
      url,
      page,
    ));
    sections.push(snap);
  }
  const kept = previous.seenEntryIds.filter((id) => !ids.includes(id));
  return {
    items: items.slice(0, limit),
    sections: sections.slice(0, MAX_SECTIONS),
    seenEntryIds: [...ids, ...kept].slice(0, MAX_ENTRY_IDS),
  };
}

// ---------------------------------------------------------------------------------------------
// Page mode

/** Preview of a page: the first sections as sample items. */
export function previewPage(sections: Section[], page: WatchPage, limit: number): RawItem[] {
  return sections.slice(0, Math.min(limit, PREVIEW_ITEMS)).map((section) =>
    finish(
      {
        externalId: id32(`sample|${section.path}|${contentHash(section.text)}`),
        url: page.url,
        title: truncate(section.level === 0 ? page.title : section.path, 300),
        kind: "doc_change",
        text: truncate(section.text, RAW_ITEM_MAX_TEXT),
        meta: { sample: true, note: PAGE_PREVIEW_NOTE, path: section.path, pageTitle: page.title },
      },
      page,
      section.text,
    ),
  );
}

export function snapshotOfSections(sections: Section[]): DocsSnapshotSection[] {
  return sections.slice(0, MAX_SECTIONS).map((section) => snapshotSection(section.path, section.text));
}

interface PageChange {
  section: Section;
  hash: string;
  old: DocsSnapshotSection | undefined;
  text: string;
}

export function pollPage(args: {
  sections: Section[];
  previous: DocsCursor | null;
  page: WatchPage;
  limit: number;
}): { items: RawItem[]; sections: DocsSnapshotSection[] } {
  const { sections, previous, page, limit } = args;
  const current = sections.slice(0, MAX_SECTIONS);
  // The first snapshot is a baseline: no item.
  if (previous === null) return { items: [], sections: snapshotOfSections(current) };

  const known = new Map(previous.sections.map((s) => [s.path, s]));
  const next: DocsSnapshotSection[] = [];
  const changes: PageChange[] = [];
  for (const section of current) {
    const snap = snapshotSection(section.path, section.text);
    const { hash, text: stored } = snap;
    const old = known.get(section.path);
    if (old !== undefined && old.hash === hash) {
      next.push(snap);
      continue;
    }
    if (old !== undefined && page.ignoreMinorEdits && comparable(old, section.text) && isMinorEdit(old.text, stored)) {
      next.push(old);
      continue;
    }
    next.push(snap);
    const text = changeText(old, section.blocks, section.text);
    changes.push({ section, hash, old, text });
  }
  if (changes.length === 0) return { items: [], sections: next };

  if (changes.length > LARGE_REVISION_SECTIONS) {
    const paths = changes.map((c) => c.section.path);
    const list = paths.map((path) => `- ${path}`).join("\n");
    const details = changes.map((c) => `${c.section.path}\n\n${c.text}`).join("\n\n");
    const text = `${changes.length} sections are new or changed:\n${list}\n\n${details}`;
    const item = finish(
      {
        externalId: id32(`revision|${changes.map((c) => `${c.section.path}|${c.hash}`).join("\n")}`),
        url: page.url,
        title: truncate(`Large revision of ${page.title}`, 300),
        kind: "doc_change",
        text: truncate(text, RAW_ITEM_MAX_TEXT),
        meta: { change: "large_revision", paths, pageTitle: page.title },
      },
      page,
      changes.map((c) => c.text).join("\n"),
    );
    return { items: [item], sections: next };
  }

  const items = changes.map((c) => {
    const isNew = c.old === undefined;
    const datetime = c.section.datetime !== undefined ? Date.parse(c.section.datetime) : NaN;
    return finish(
      {
        externalId: id32(`page|${c.section.path}|${c.hash}`),
        url: page.url,
        title: truncate(`${isNew ? "New section" : "Updated"}: ${c.section.level === 0 ? page.title : c.section.path}`, 300),
        kind: "doc_change",
        text: truncate(c.text, RAW_ITEM_MAX_TEXT),
        meta: {
          change: isNew ? "new_section" : "changed_section",
          path: c.section.path,
          pageTitle: page.title,
          before: c.old?.text ?? "",
          after: truncate(c.section.text, MAX_SECTION_TEXT),
        },
      },
      page,
      c.text,
      Number.isFinite(datetime) ? datetime : undefined,
    );
  });
  return { items: items.slice(0, limit), sections: next };
}
