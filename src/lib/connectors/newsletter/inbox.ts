// The inbox variant of the newsletter connector: one email = one item.
import { z } from "zod";

import type { MailMessage } from "@/lib/mail/types";
import { canonicalizeUrl, decodeEntities, extractLinks, htmlToText, sha } from "@/lib/text";

import { capText } from "../blog/feed-source";
import { RAW_ITEM_MAX_LINKS, type RawItem } from "../types";

export interface InboxCursor {
  uidValidity: number;
  lastUid: number;
}

export const inboxCursorSchema = z.object({
  uidValidity: z.number().int().nonnegative(),
  lastUid: z.number().int().nonnegative(),
});

export function readInboxCursor(cursor: unknown): InboxCursor | null {
  const parsed = inboxCursorSchema.safeParse(cursor);
  return parsed.success ? parsed.data : null;
}

/** The newest messages after a UIDVALIDITY change. */
export const RESET_LIMIT = 10;
/** The most messages of a preview. */
export const PREVIEW_LIMIT = 10;

/** The address of a From value: "Name <a@b.c>" -> "a@b.c" (lower case). */
export function senderAddress(from: string): string {
  const angle = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(from);
  const address = angle?.[1] ?? /[^\s<>"',;:]+@[^\s<>"',;:]+\.[^\s<>"',;:]+/.exec(from)?.[0] ?? from;
  return address.trim().toLowerCase();
}

/** The display name of a From value, else the address. */
export function senderName(from: string): string {
  const name = /^\s*"?([^"<]*?)"?\s*</.exec(from)?.[1]?.trim();
  return name && name !== "" ? name : senderAddress(from);
}

/**
 * A sender that a person typed: "news@example.com", "mailto:news@example.com",
 * or "Example News <news@example.com>". Null for anything else.
 */
export function parseSenderInput(input: string): string | null {
  const text = input.trim();
  if (text === "" || text.length > 300) return null;
  const inAngle = /<\s*(?:mailto:)?([^<>\s]+)\s*>\s*$/i.exec(text)?.[1];
  const candidate = (inAngle ?? text.replace(/^mailto:/i, "")).trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(candidate)
    ? candidate
    : null;
}

const VIEW_PHRASE =
  /\b(?:view|read|open|see)\b[^.<>\n]{0,30}?\b(?:in|on)\s+(?:your\s+|a\s+|the\s+)?(?:web\s*)?browser\b|\bview\s+(?:it\s+|this\s+(?:post|email|issue|newsletter)\s+)?(?:online|on\s+the\s+web)\b|\bweb\s+version\b|\bread\s+(?:it\s+)?online\b/i;

function hrefOf(attrs: string): string | undefined {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  if (raw === undefined) return undefined;
  const href = decodeEntities(raw).trim();
  return /^https?:\/\//i.test(href) ? href : undefined;
}

/**
 * The "view in browser" link of a newsletter email: the first <a> whose text
 * says "View in browser", "View online", "Read online", "Web version", or
 * "View this post on the web"; else such a phrase in the plain text that an
 * http(s) address follows on the same line or the next line.
 */
export function findViewInBrowserLink(html: string | undefined, text: string): string | undefined {
  if (html) {
    for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const label = htmlToText(m[2] ?? "").replace(/\s+/g, " ").trim();
      if (label.length > 80 || !VIEW_PHRASE.test(label)) continue;
      const href = hrefOf(m[1] ?? "");
      if (href) return href;
    }
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!VIEW_PHRASE.test(line)) continue;
    const here = /https?:\/\/[^\s<>()[\]"']+/.exec(line.slice(line.search(VIEW_PHRASE)))?.[0];
    const next = /^\s*[<([]?\s*(https?:\/\/[^\s<>()[\]"']+)/.exec(lines[i + 1] ?? "")?.[1];
    const found = here ?? next;
    if (found) return found.replace(/[.,;:!?]+$/, "");
  }
  return undefined;
}

const NOT_CONTENT_LINK = /unsubscribe|list-manage\.com\/profile|\/preferences|\/subscription|manage[-_]?subscription|\/account\b|mailto:/i;

/** Maps one message to an item (kind email). */
export function messageToItem(msg: MailMessage): RawItem {
  const text = capText(msg.text.trim() !== "" ? msg.text : msg.html ? htmlToText(msg.html) : "");
  const messageId = msg.messageId.trim().replace(/^<|>$/g, "").trim();
  const item: RawItem = {
    externalId: messageId !== "" ? messageId.slice(0, 300) : `sha:${sha(`${msg.from}\n${msg.subject}\n${msg.date}`)}`,
    title: msg.subject.trim() || "(no subject)",
    kind: "email",
    text,
    meta: { sender: senderAddress(msg.from), uid: msg.uid },
  };
  const author = senderName(msg.from);
  if (author) item.author = author;
  if (msg.date > 0) item.publishedAt = msg.date;
  const view = findViewInBrowserLink(msg.html, msg.text);
  if (view) item.url = view;
  const own = view ? canonicalizeUrl(view) : undefined;
  const links = extractLinks(msg.html ?? msg.text)
    .filter((link) => link !== own && !NOT_CONTENT_LINK.test(link))
    .slice(0, RAW_ITEM_MAX_LINKS);
  if (links.length > 0) item.links = links;
  return item;
}
