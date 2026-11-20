import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import { blocksToText, htmlToBlocks, htmlToText, type TextBlock } from "./blocks";
import { slugify, stripInvisible, truncate } from "./words";

/** One section of a page: the content from one heading (h1 to h4) to the next heading. */
export interface Section {
  /** The heading texts from the top, joined with " > ". "(intro)" for content before the first heading. */
  path: string;
  /** The text of the section, without its heading. */
  text: string;
  /** Each paragraph or top-level list item of the section as one string (a list item has no "- "). */
  blocks: string[];
  /** The heading level, 1 to 4. 0 for "(intro)". */
  level: number;
  /** The `datetime` value of the first <time> element of the section, when there is one. */
  datetime?: string;
}

const INTRO_PATH = "(intro)";
const MAX_HEADING_TEXT = 200;
const MAX_PREAMBLE = 200;

const DROPPED = "script,style,noscript,template,svg,head";
const HIDDEN = '[hidden],[aria-hidden="true"],.sr-only,.visually-hidden,.screen-reader-text,.screen-reader-only';
const CHROME =
  "nav,aside,footer,button,dialog,select,textarea,input,form," +
  '[role="navigation"],[role="dialog"],[role="alert"],[role="status"],[role="search"],[role="complementary"],' +
  '[role="banner"],[role="contentinfo"],[role="toolbar"],[role="menu"],[role="menubar"],[role="tablist"]';
/** Words in a class or an id that mark page furniture. */
const CHROME_TOKEN = /(?:^|[^a-z0-9])(?:feedback|footer|breadcrumbs?|sidebar|cookies?|newsletter|subscribe|toc|popover|comments)(?:[^a-z0-9]|$)/i;
const PERMALINK_MARKS = new Set(["", "#", "¶", "§", "🔗"]);

function parseDocument(html: string): Document {
  const full = /<html[\s>]|<body[\s>]/i.test(html)
    ? html
    : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  return parseHTML(full).document;
}

function textLength(el: Element): number {
  return (el.textContent ?? "").length;
}

function removeAll(root: Element, selector: string, keep?: (el: Element) => boolean): void {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (!root.contains(el) || (keep !== undefined && keep(el))) continue;
    el.remove();
  }
}

/** Removes the parts of a content element that are not content: controls, navigation, hidden parts. */
function pruneChrome(root: Element, keepJsonLd = false): void {
  removeAll(root, DROPPED, keepJsonLd ? (el) => el.getAttribute("type") === "application/ld+json" : undefined);
  const total = Math.max(1, textLength(root));
  // A hidden element with most of the text is content that a script shows later.
  removeAll(root, HIDDEN, (el) => textLength(el) > total * 0.5);
  removeAll(root, CHROME, (el) => textLength(el) > total * 0.3);
  for (const heading of Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    for (const a of Array.from(heading.querySelectorAll("a"))) {
      if (PERMALINK_MARKS.has((a.textContent ?? "").trim()) && a.querySelector("img") === null) a.remove();
    }
  }
  for (const el of Array.from(root.querySelectorAll("div,section,ul,ol,p,span,details"))) {
    if (!root.contains(el)) continue;
    const id = el.getAttribute("id") ?? "";
    const marks = `${el.getAttribute("class") ?? ""} ${id}`;
    if (marks.length < 4 || !CHROME_TOKEN.test(marks)) continue;
    if (textLength(el) > total * 0.2 || el.querySelector("h1") !== null) continue;
    // An id that is the slug of the element's own heading is a content section ("#cookies").
    const heading = el.querySelector("h1,h2,h3,h4,h5,h6");
    if (heading !== null && id !== "" && slugify(heading.textContent ?? "") === slugify(id)) continue;
    el.remove();
  }
}

/** The element that holds the main content: <main>, or the one <article>, or the parent of all <article>s. */
function findMainRoot(document: Document): Element | null {
  const main = document.querySelector('main,[role="main"]');
  if (main !== null) return main;
  const articles = Array.from(document.querySelectorAll("article"));
  const first = articles[0];
  if (first === undefined) return null;
  if (articles.length === 1) return first;
  const last = articles[articles.length - 1];
  let parent: Element | null = first.parentElement;
  while (parent !== null && last !== undefined && !parent.contains(last)) parent = parent.parentElement;
  return parent;
}

function runReadability(html: string): { title: string; content: string } | null {
  try {
    // Readability changes the document, so it gets its own copy. Controls, navigation, and hidden
    // parts go first: Readability can take a hidden dialog for the article on a page of link lists.
    const document = parseDocument(html);
    const body = document.body as Element | null;
    if (body !== null) pruneChrome(body, true);
    const result = new Readability(document).parse();
    if (result === null) return null;
    return { title: result.title ?? "", content: typeof result.content === "string" ? result.content : "" };
  } catch {
    return null;
  }
}

function oneLine(text: string): string {
  return stripInvisible(text).replace(/\s+/g, " ").trim();
}

function prunedText(el: Element): string {
  pruneChrome(el);
  return htmlToText(el.innerHTML);
}

/**
 * The title and the main text of a page. Readability finds the main content. When it finds nothing,
 * or much less than the <main> / <article> element holds (a page of link lists, a changelog), the
 * text is the text of <main>, then <article>, then <body>.
 */
export function extractArticle(html: string, url: string): { title: string; text: string } {
  if (typeof html !== "string" || html.trim() === "") return { title: "", text: "" };
  const readable = runReadability(html);
  const document = parseDocument(html);

  let title = oneLine(readable?.title ?? "");
  if (title === "") {
    title = oneLine(
      document.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
        document.querySelector("title")?.textContent ??
        document.querySelector("h1")?.textContent ??
        "",
    );
  }
  if (title === "") {
    try {
      const u = new URL(url);
      title = u.hostname + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      title = "";
    }
  }

  const readableText = readable !== null ? htmlToText(readable.content) : "";
  const mainRoot = findMainRoot(document);
  const mainText = mainRoot !== null ? prunedText(mainRoot) : "";
  let text: string;
  if (readableText !== "" && (mainText === "" || readableText.length >= mainText.length * 0.5)) text = readableText;
  else if (mainText !== "") text = mainText;
  else if (readableText !== "") text = readableText;
  else text = document.body ? prunedText(document.body) : htmlToText(html);
  return { title: truncate(title, 300), text: stripInvisible(text) };
}

function headingText(block: TextBlock): string {
  return truncate(oneLine(block.text), MAX_HEADING_TEXT);
}

/**
 * Splits the main content of a page into sections, one for each heading h1 to h4.
 * The main content is the element of `selector` when given (no match gives []); else <main>,
 * the <article> element(s), the Readability content, or <body>. Content before the first heading
 * has the path "(intro)". Content at the start of an <article>, before its first heading (a date
 * line), belongs to that heading. Sections with no text are dropped. A path that occurs again
 * gets " (2)", " (3)", … at its end.
 */
export function splitSections(html: string, selector?: string): Section[] {
  if (typeof html !== "string" || html.trim() === "") return [];
  const document = parseDocument(html);
  let root: Element | null = null;
  if (selector !== undefined && selector.trim() !== "") {
    try {
      root = document.querySelector(selector);
    } catch {
      root = null;
    }
    if (root === null) return [];
  } else {
    root = findMainRoot(document);
    if (root === null) {
      const readable = runReadability(html);
      if (readable !== null && htmlToText(readable.content).length >= 200) {
        root = parseDocument(readable.content).body;
      }
    }
    // A document with no <body> element gives null here.
    root ??= document.body as Element | null;
    if (root === null) return [];
  }
  pruneChrome(root);
  // An <article> root keeps its own tag, so that its date line goes to its first heading.
  const blocks = htmlToBlocks(root.tagName.toLowerCase() === "article" ? root.outerHTML : root.innerHTML);

  interface Draft {
    path: string;
    level: number;
    blocks: TextBlock[];
  }
  const drafts: Draft[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let current: Draft | null = null;
  /** Blocks since the start of an <article> that has had no heading yet; null outside that state. */
  let preamble: TextBlock[] | null = null;

  let preambleLength = 0;

  const addToCurrent = (block: TextBlock): void => {
    if (current === null) {
      current = { path: INTRO_PATH, level: 0, blocks: [] };
      drafts.push(current);
    }
    current.blocks.push(block);
  };
  /** Gives the blocks of the open preamble to the section before it. */
  const flushPreamble = (): void => {
    if (preamble !== null) for (const b of preamble) addToCurrent(b);
    preamble = null;
    preambleLength = 0;
  };

  for (const block of blocks) {
    if (block.kind === "boundary") {
      flushPreamble();
      preamble = block.open === true ? [] : null;
      continue;
    }
    const isSectionHeading = block.kind === "heading" && block.level >= 1 && block.level <= 4;
    const text = isSectionHeading ? headingText(block) : "";
    if (!isSectionHeading || text === "") {
      if (preamble === null) {
        addToCurrent(block);
        continue;
      }
      preamble.push(block);
      preambleLength += block.text.length;
      // A long text before the first heading is the body of the article, not a date line.
      if (preambleLength > MAX_PREAMBLE) flushPreamble();
      continue;
    }
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= block.level) stack.pop();
    stack.push({ level: block.level, text });
    current = { path: stack.map((s) => s.text).join(" > "), level: block.level, blocks: [] };
    drafts.push(current);
    if (block.datetime !== undefined) current.blocks.push({ ...block, kind: "boundary", text: "" });
    if (preamble !== null) {
      current.blocks.push(...preamble);
      preamble = null;
      preambleLength = 0;
    }
  }
  flushPreamble();

  const seen = new Map<string, number>();
  const sections: Section[] = [];
  for (const draft of drafts) {
    const content = draft.blocks.filter((b) => b.kind !== "boundary");
    const text = stripInvisible(blocksToText(content));
    if (text.trim() === "") continue;
    const count = (seen.get(draft.path) ?? 0) + 1;
    seen.set(draft.path, count);
    const section: Section = {
      path: count === 1 ? draft.path : `${draft.path} (${count})`,
      text,
      blocks: content.map((b) => stripInvisible(b.text)),
      level: draft.level,
    };
    const datetime = draft.blocks.find((b) => b.datetime !== undefined)?.datetime;
    if (datetime !== undefined) section.datetime = datetime;
    sections.push(section);
  }
  return sections;
}
