// The mailbox reader of the newsletter inbox variant (specification §6.3,
// §11.5): imapflow + mailparser, TLS only, read-only.
//
// Rules: connects only to IMAP_HOST:IMAP_PORT of the environment (never to an
// address that a person typed); opens the mailbox read-only (EXAMINE); fetches
// with BODY.PEEK (imapflow), so no flag changes; one connection for each
// list() call, closed in a finally block; no log of message content.
import { hasMailbox, type Env } from "@/lib/env";

import { MailError } from "./errors";
import type { MailMessage, MailReader } from "./types";

export type { MailMessage, MailReader } from "./types";
export { MailError, type MailErrorKind } from "./errors";

/** The largest raw message that the reader fetches (bytes). */
export const MAX_MESSAGE_BYTES = 5_000_000;
/** The most messages for one list() call. */
export const MAX_LIST = 50;

export interface MailSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
}

/** The options that the reader gives to the IMAP client (a subset of ImapFlowOptions). */
export interface ImapClientOptions {
  host: string;
  port: number;
  secure: true;
  servername: string;
  auth: { user: string; pass: string };
  logger: false;
  disableAutoIdle: true;
  tls: { rejectUnauthorized: true; minVersion: "TLSv1.2" };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

/** The part of the ImapFlow client that the reader uses (tests give a fake). */
export interface ImapClientLike {
  connect(): Promise<void>;
  mailboxOpen(path: string, options: { readOnly: boolean }): Promise<{ uidValidity: bigint | number }>;
  search(
    query: { from?: string; subject?: string; uid?: string },
    options: { uid: boolean },
  ): Promise<number[] | false | undefined | unknown>;
  fetch(
    range: string,
    query: { uid: boolean; source: { maxLength: number }; internalDate: boolean },
    options: { uid: boolean },
  ): AsyncIterable<{ uid: number; source?: Buffer; internalDate?: Date | string }>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapClientFactory = (options: ImapClientOptions) => ImapClientLike | Promise<ImapClientLike>;

const realFactory: ImapClientFactory = async (options) => {
  // Loaded on first use, so that importing this module stays cheap.
  const { ImapFlow } = await import("imapflow");
  const client: ImapClientLike = new ImapFlow(options);
  return client;
};

function isAuthFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { authenticationFailed?: unknown; name?: unknown; serverResponseCode?: unknown };
  return e.authenticationFailed === true || e.name === "AuthenticationFailure" || e.serverResponseCode === "AUTHENTICATIONFAILED";
}

function toMailError(error: unknown, settings: MailSettings): MailError {
  if (error instanceof MailError) return error;
  if (isAuthFailure(error)) {
    return new MailError("auth", "The mailbox refused the user name or the password (IMAP_USER, IMAP_PASSWORD).", { cause: error });
  }
  return new MailError(
    "network",
    `The app could not read the mailbox at ${settings.host}:${settings.port} (TLS). Check IMAP_HOST and IMAP_PORT.`,
    { cause: error },
  );
}

function toDateMs(value: Date | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A MailReader over one IMAP account. `factory` makes the client (a fake in tests). */
export function createImapMailReader(settings: MailSettings, factory: ImapClientFactory = realFactory): MailReader {
  return {
    async list(q) {
      const limit = Math.max(0, Math.min(MAX_LIST, Math.floor(q.limit)));
      const options: ImapClientOptions = {
        host: settings.host,
        port: settings.port,
        secure: true,
        servername: settings.host,
        auth: { user: settings.user, pass: settings.password },
        logger: false,
        disableAutoIdle: true,
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
      };
      let client: ImapClientLike | undefined;
      try {
        client = await factory(options);
        await client.connect();

        let uidValidity: number;
        try {
          const box = await client.mailboxOpen(settings.mailbox, { readOnly: true });
          uidValidity = Number(box.uidValidity);
        } catch (error) {
          if (isAuthFailure(error)) throw error;
          throw new MailError("not_found", `The mailbox folder "${settings.mailbox}" does not exist (IMAP_MAILBOX).`, {
            cause: error,
          });
        }

        const query: { from?: string; subject?: string; uid?: string } = { from: q.from };
        if (q.subjectIncludes) query.subject = q.subjectIncludes;
        if (q.sinceUid !== null) query.uid = `${Math.max(1, Math.floor(q.sinceUid) + 1)}:*`;
        const found = await client.search(query, { uid: true });
        const uids = (Array.isArray(found) ? found : [])
          .filter((uid): uid is number => typeof uid === "number" && Number.isInteger(uid) && uid > 0)
          // "n:*" always holds the highest UID, also when it is lower than n.
          .filter((uid) => q.sinceUid === null || uid > q.sinceUid)
          .sort((a, b) => b - a)
          .slice(0, limit);
        if (uids.length === 0) return { uidValidity, messages: [] };

        // Collect first, parse after: no other work runs inside the fetch loop.
        const raw: Array<{ uid: number; source: Buffer; internalDate?: number }> = [];
        for await (const msg of client.fetch(
          uids.join(","),
          { uid: true, source: { maxLength: MAX_MESSAGE_BYTES }, internalDate: true },
          { uid: true },
        )) {
          if (!msg.source) continue;
          const internalDate = toDateMs(msg.internalDate);
          raw.push({ uid: msg.uid, source: msg.source, ...(internalDate !== undefined ? { internalDate } : {}) });
        }

        const { parseMessage } = await import("./parse");
        const messages: MailMessage[] = [];
        for (const r of raw) {
          try {
            messages.push(await parseMessage(r.source, { uid: r.uid, ...(r.internalDate !== undefined ? { fallbackDate: r.internalDate } : {}) }));
          } catch {
            // A message that mailparser cannot read is left out.
          }
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { uidValidity, messages };
      } catch (error) {
        throw toMailError(error, settings);
      } finally {
        if (client) {
          try {
            await client.logout();
          } catch {
            client.close();
          }
        }
      }
    },
  };
}

/** The reader of the dedicated mailbox, or null when IMAP_HOST, IMAP_USER, or IMAP_PASSWORD is absent. */
export function createMailReader(env: Env, factory?: ImapClientFactory): MailReader | null {
  if (!hasMailbox(env)) return null;
  const host = env.imapHost;
  const user = env.imapUser;
  const password = env.imapPassword;
  if (!host || !user || !password) return null;
  return createImapMailReader({ host, port: env.imapPort, user, password, mailbox: env.imapMailbox }, factory);
}
