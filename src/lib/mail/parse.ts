// Turns the raw source of one email (RFC 822) into the message shape of
// MailReader.list, with mailparser. No network.
import { simpleParser, type AddressObject } from "mailparser";

import { htmlToText, stripInvisible } from "@/lib/text";

import type { MailMessage } from "./types";

/** "Name <address>" of the first sender, or the address alone. */
function fromText(from: AddressObject | undefined): string {
  const first = from?.value[0];
  const address = (first?.address ?? "").trim();
  const name = (first?.name ?? "").replace(/\s+/g, " ").trim();
  if (address === "") return (from?.text ?? "").replace(/\s+/g, " ").trim();
  return name !== "" ? `${name} <${address}>` : address;
}

/** The largest HTML part that the reader keeps (characters). */
export const MAX_HTML_CHARS = 1_000_000;

/**
 * Parses one message. `text` is the plain-text part; when the message has no
 * plain-text part, it is htmlToText of the HTML part. `date` is the Date
 * header, else `fallbackDate` (the IMAP internal date), else 0.
 */
export async function parseMessage(
  source: Buffer | string,
  meta: { uid: number; fallbackDate?: number },
): Promise<MailMessage> {
  const mail = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });

  const html = typeof mail.html === "string" && mail.html.trim() !== "" ? mail.html.slice(0, MAX_HTML_CHARS) : undefined;
  const plain = typeof mail.text === "string" ? stripInvisible(mail.text).trim() : "";
  const text = plain !== "" ? plain : html ? htmlToText(html) : "";

  const headerDate = mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date.getTime() : undefined;
  const date = headerDate ?? meta.fallbackDate ?? 0;

  const message: MailMessage = {
    uid: meta.uid,
    messageId: (mail.messageId ?? "").trim(),
    from: fromText(mail.from),
    subject: (mail.subject ?? "").replace(/\s+/g, " ").trim(),
    date,
    text,
  };
  if (html !== undefined) message.html = html;
  return message;
}
