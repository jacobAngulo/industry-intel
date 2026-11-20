import { parseAttributes } from "./attrs";
import { decodeEntities } from "./entities";

/**
 * One unit of text from an HTML document: a heading, a paragraph, or a top-level list item.
 * A "boundary" block marks the start (`open: true`) or the end of an <article> element.
 */
export interface TextBlock {
  kind: "heading" | "text" | "li" | "boundary";
  /** Heading level 1 to 6. 0 for the other kinds. */
  level: number;
  /** Lines joined with "\n". A list item has no "- " at its start; its nested items have. */
  text: string;
  /** Identity of the top-level list of a "li" block. 0 for the other kinds. */
  listId: number;
  /** The `datetime` value of the first <time> element in the block. */
  datetime?: string;
  open?: boolean;
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
/** Dropped with their content. The content is raw text: it ends at the first close tag. */
const DROP_RAW = new Set(["script", "style"]);
/** Dropped with their content. */
const DROP = new Set([
  "noscript", "template", "svg", "head", "title", "iframe", "object", "canvas", "audio", "video", "picture",
  "map", "math", "select", "datalist", "textarea",
]);
/** A hidden marker on these elements is ignored: pages show them with a script. */
const NEVER_HIDDEN = new Set(["html", "body", "main", "article"]);
const BLOCK = new Set([
  "p", "div", "section", "header", "footer", "main", "aside", "nav", "blockquote", "table", "figure",
  "figcaption", "form", "fieldset", "address", "details", "summary", "hr", "body", "html", "dl", "center",
  "caption",
]);
const LINE = new Set(["tr", "dt", "dd", "option", "legend"]);

const TAG_START = /<[a-zA-Z!/?]/;
const BLOCK_HINT = /<(?:p|div|br|li|ul|ol|h[1-6]|table|tr|blockquote|pre|section|article|body|html|hr|dl|dd|dt)\b/i;
const HIDDEN_HINT = /hidden|display\s*:\s*none/i;
const NEWLINE = /\r\n?|\n/;
/** After this number of searches for a close tag that find none, hidden elements are not skipped any more. */
const MAX_FAILED_SEARCHES = 10;
const MAX_HEADING_LENGTH = 300;

function isLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isNameChar(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 58) /* digits and ":" */ || code === 45 || code === 95;
}

/** Index of the ">" that ends the tag whose attributes start at `from`; -1 when there is none. */
function findTagEnd(html: string, from: number): number {
  const n = html.length;
  for (let j = from; j < n; j++) {
    const code = html.charCodeAt(j);
    if (code === 62 /* > */) return j;
    if (code === 34 /* " */ || code === 39 /* ' */) {
      const close = html.indexOf(code === 34 ? '"' : "'", j + 1);
      if (close > 0) {
        // A quote with no partner before the next ">" is plain text, not the start of a value.
        const gt = html.indexOf(">", j + 1);
        if (gt < 0 || close < gt || html.charCodeAt(j - 1) === 61 /* = */) j = close;
      }
    }
  }
  return -1;
}

const closeSearch = new Map<string, RegExp>();

/** Index after the close tag that matches an open tag of `name`; -1 when there is none. */
function findClose(html: string, name: string, from: number, nested: boolean): number {
  let re = closeSearch.get(name);
  if (!re) {
    re = new RegExp(`<(/?)${name.replace(/[^a-z0-9:_-]/g, "")}(?=[\\s>/])`, "gi");
    // Tag names come from the documents: the cache must not grow without a limit.
    if (closeSearch.size >= 200) closeSearch.clear();
    closeSearch.set(name, re);
  }
  re.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) {
        const end = html.indexOf(">", match.index);
        return end < 0 ? html.length : end + 1;
      }
    } else if (nested) {
      depth += 1;
    }
  }
  return -1;
}

function isHidden(attrs: string): boolean {
  const a = parseAttributes(attrs);
  if (Object.hasOwn(a, "hidden")) return true;
  if ((a["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = a["style"];
  return style !== undefined && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
}

class Renderer {
  readonly blocks: TextBlock[] = [];
  /** True when a newline in the source is a line break (plain text, or HTML with inline tags only). */
  keepNewlines = false;

  private lines: string[] = [];
  private line = "";
  private pendingSpace = false;
  private lastBreak = false;
  private kind: TextBlock["kind"] = "text";
  private level = 0;
  private listId = 0;
  private datetime: string | undefined;
  private bullet: string | null = null;
  private listDepth = 0;
  private listCounter = 0;
  private currentListId = 0;
  private inTopItem = false;
  private inHeading = false;
  private pre = 0;

  text(raw: string): void {
    if (raw === "") return;
    const s = raw.includes("&") ? decodeEntities(raw) : raw;
    if (this.pre > 0) {
      const parts = s.split(NEWLINE);
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) this.flushPreLine();
        this.line += (parts[k] ?? "").replace(/\t/g, "  ");
      }
      return;
    }
    if (this.keepNewlines && (s.includes("\n") || s.includes("\r"))) {
      const parts = s.split(NEWLINE);
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) this.softBreak();
        this.inline(parts[k] ?? "");
      }
      return;
    }
    this.inline(s);
  }

  open(name: string, attrs: string): void {
    if (name === "br") {
      if (this.pre > 0) this.flushPreLine();
      else this.softBreak();
      return;
    }
    if (name === "li") {
      if (this.listDepth <= 1) {
        this.breakBlock();
        this.kind = "li";
        this.listId = this.listDepth === 0 ? -1 : this.currentListId;
        this.inTopItem = true;
      } else {
        this.breakLine();
        this.bullet = "  ".repeat(this.listDepth - 1) + "- ";
      }
      return;
    }
    if (name === "ul" || name === "ol") {
      if (this.listDepth === 0) {
        this.breakBlock();
        this.listCounter += 1;
        this.currentListId = this.listCounter;
      } else {
        this.breakLine();
      }
      this.listDepth += 1;
      return;
    }
    if (name.length === 2 && name.charCodeAt(0) === 104 /* h */ && name >= "h1" && name <= "h6") {
      this.breakBlock();
      this.inTopItem = false;
      this.kind = "heading";
      this.level = name.charCodeAt(1) - 48;
      this.inHeading = true;
      return;
    }
    if (name === "pre") {
      this.block();
      this.pre += 1;
      return;
    }
    if (name === "article") {
      this.breakBlock();
      this.blocks.push({ kind: "boundary", level: 0, text: "", listId: 0, open: true });
      return;
    }
    if (name === "td" || name === "th") {
      if (this.line !== "") this.pendingSpace = true;
      return;
    }
    if (name === "time") {
      if (this.datetime === undefined && /datetime/i.test(attrs)) {
        const value = (parseAttributes(attrs)["datetime"] ?? "").trim();
        if (value !== "") this.datetime = value.slice(0, 64);
      }
      return;
    }
    if (BLOCK.has(name)) this.block();
    else if (LINE.has(name)) this.breakLine();
  }

  close(name: string): void {
    if (name === "li") {
      if (this.listDepth <= 1) {
        this.breakBlock();
        this.inTopItem = false;
      } else {
        this.breakLine();
        this.bullet = null;
      }
      return;
    }
    if (name === "ul" || name === "ol") {
      if (this.listDepth > 0) this.listDepth -= 1;
      if (this.listDepth === 0) {
        this.breakBlock();
        this.inTopItem = false;
      } else {
        this.breakLine();
      }
      return;
    }
    if (name.length === 2 && name >= "h1" && name <= "h6") {
      this.breakBlock();
      this.inHeading = false;
      return;
    }
    if (name === "pre") {
      if (this.pre > 0) {
        this.flushPreLine();
        this.pre -= 1;
      }
      this.block();
      return;
    }
    if (name === "article") {
      this.breakBlock();
      this.blocks.push({ kind: "boundary", level: 0, text: "", listId: 0, open: false });
      return;
    }
    if (name === "td" || name === "th") {
      if (this.line !== "") this.pendingSpace = true;
      return;
    }
    if (BLOCK.has(name)) this.block();
    else if (LINE.has(name)) this.breakLine();
  }

  finish(): TextBlock[] {
    if (this.pre > 0) this.flushPreLine();
    this.breakBlock();
    return this.blocks;
  }

  private inline(s: string): void {
    const core = s.replace(/\s+/g, " ").trim();
    if (core === "") {
      if (this.line !== "" && s !== "") this.pendingSpace = true;
      return;
    }
    if (this.line !== "" && (this.pendingSpace || /^\s/.test(s))) this.line += " ";
    this.line += core;
    this.pendingSpace = /\s$/.test(s);
    this.lastBreak = false;
  }

  /** A paragraph-level break. Inside a list item or a heading it is only a line break. */
  private block(): void {
    if (this.inHeading && this.blockLength() > MAX_HEADING_LENGTH) {
      // The heading has no close tag: stop it here.
      this.breakBlock();
      this.inHeading = false;
      return;
    }
    if (this.listDepth > 0 || this.inTopItem || this.inHeading) this.breakLine();
    else this.breakBlock();
  }

  private blockLength(): number {
    let total = this.line.length;
    for (const l of this.lines) total += l.length;
    return total;
  }

  /** A line break from <br> or from a source newline. Two in sequence end the paragraph. */
  private softBreak(): void {
    if (this.line === "" && this.lastBreak) {
      if (this.listDepth > 0 || this.inTopItem || this.inHeading) this.breakLine();
      else this.breakBlock();
    } else {
      this.breakLine();
    }
    this.lastBreak = true;
  }

  private flushLine(): void {
    if (this.line !== "") {
      const text = this.pre > 0 ? this.line.replace(/\s+$/, "") : this.line;
      if (text !== "") {
        this.lines.push((this.bullet ?? "") + text);
        this.bullet = null;
      }
    }
    this.line = "";
    this.pendingSpace = false;
  }

  /** Inside <pre>: keeps the line as it is, and keeps one empty line between lines. */
  private flushPreLine(): void {
    const text = this.line.replace(/\s+$/, "");
    this.line = "";
    if (text !== "") this.lines.push(text);
    else if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") this.lines.push("");
  }

  private breakLine(): void {
    this.flushLine();
  }

  private breakBlock(): void {
    this.flushLine();
    while (this.lines.length > 0 && this.lines[this.lines.length - 1] === "") this.lines.pop();
    if (this.lines.length > 0) {
      const block: TextBlock = { kind: this.kind, level: this.level, text: this.lines.join("\n"), listId: this.listId };
      if (this.datetime !== undefined) block.datetime = this.datetime;
      this.blocks.push(block);
      this.datetime = undefined;
      this.lines = [];
    }
    this.kind = "text";
    this.level = 0;
    this.listId = 0;
    this.bullet = null;
  }
}

/** Turns HTML (or plain text) into text blocks, in document order. */
export function htmlToBlocks(input: string): TextBlock[] {
  if (typeof input !== "string" || input === "") return [];
  const html = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const r = new Renderer();
  if (!TAG_START.test(html)) {
    r.keepNewlines = true;
    r.text(html);
    return r.finish();
  }
  r.keepNewlines = !BLOCK_HINT.test(html);

  const n = html.length;
  let failedSearches = 0;
  // The position of the last close tag of each name, so that a document with no close tag for a
  // name is not searched again and again.
  let lower: string | null = null;
  const lastClose = new Map<string, number>();
  const closeFrom = (name: string, from: number, nested: boolean): number => {
    let last = lastClose.get(name);
    if (last === undefined) {
      lower ??= html.toLowerCase();
      last = lower.lastIndexOf(`</${name}`);
      lastClose.set(name, last);
    }
    if (last < from) return -1;
    if (failedSearches >= MAX_FAILED_SEARCHES) return -1;
    const close = findClose(html, name, from, nested);
    if (close < 0) failedSearches += 1;
    return close;
  };
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      r.text(html.slice(i));
      break;
    }
    if (lt > i) r.text(html.slice(i, lt));
    const next = html.charCodeAt(lt + 1);
    if (next === 33 /* ! */) {
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        i = end < 0 ? n : end + 3;
      } else if (html.startsWith("<![CDATA[", lt)) {
        const end = html.indexOf("]]>", lt + 9);
        r.text(end < 0 ? html.slice(lt + 9) : html.slice(lt + 9, end));
        i = end < 0 ? n : end + 3;
      } else {
        const end = html.indexOf(">", lt + 2);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }
    if (next === 63 /* ? */) {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = next === 47; /* / */
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isLetter(html.charCodeAt(nameStart))) {
      r.text("<");
      i = lt + 1;
      continue;
    }
    let j = nameStart + 1;
    while (j < n && isNameChar(html.charCodeAt(j))) j++;
    const end = findTagEnd(html, j);
    if (end < 0) {
      r.text("<");
      i = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, j).toLowerCase();
    i = end + 1;
    if (closing) {
      r.close(name);
      continue;
    }
    const attrs = html.slice(j, end);
    const selfClosed = html.charCodeAt(end - 1) === 47;
    if (DROP_RAW.has(name)) {
      if (!selfClosed) {
        // A script or a style with no close tag takes the rest of the document, as in a browser.
        const close = findClose(html, name, i, false);
        i = close < 0 ? n : close;
      }
      continue;
    }
    if (DROP.has(name)) {
      if (!selfClosed) {
        const close = closeFrom(name, i, true);
        if (close >= 0) i = close;
      }
      continue;
    }
    if (attrs.length > 5 && HIDDEN_HINT.test(attrs) && !NEVER_HIDDEN.has(name) && isHidden(attrs)) {
      if (VOID.has(name) || selfClosed) continue;
      const close = closeFrom(name, i, true);
      if (close >= 0) {
        i = close;
        continue;
      }
    }
    if (VOID.has(name) && name !== "br" && name !== "hr") continue;
    r.open(name, attrs);
  }
  return r.finish();
}

/** Joins blocks to one text: an empty line between blocks, one line for each item of a list. */
export function blocksToText(blocks: TextBlock[]): string {
  let out = "";
  let prev: TextBlock | null = null;
  for (const b of blocks) {
    if (b.kind === "boundary") continue;
    if (prev !== null) out += prev.kind === "li" && b.kind === "li" && prev.listId === b.listId ? "\n" : "\n\n";
    out += b.kind === "li" ? "- " + b.text : b.text;
    prev = b;
  }
  return out;
}

/**
 * HTML to plain text. Paragraphs and headings become separate blocks with one empty line between
 * them; a list item starts with "- "; <br> gives a line break; link text stays and the address goes;
 * scripts, styles, images, and hidden elements go; character references are decoded; runs of spaces
 * collapse. Plain text comes back with the same lines.
 */
export function htmlToText(html: string): string {
  return blocksToText(htmlToBlocks(html));
}
