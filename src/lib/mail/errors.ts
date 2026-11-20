// Errors of the mailbox reader. The message never holds message content or a
// secret; it is fit to show to a person. This file has no dependency on
// imapflow, so the connectors can import it cheaply.

export type MailErrorKind = "auth" | "not_found" | "network" | "bad_response";

export class MailError extends Error {
  kind: MailErrorKind;

  constructor(kind: MailErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MailError";
    this.kind = kind;
  }
}
