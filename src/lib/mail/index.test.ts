import { describe, expect, it } from "vitest";

import { loadFixture, makeEnv } from "@/test/helpers";

import { MailError } from "./errors";
import { createImapMailReader, createMailReader, type ImapClientLike, type ImapClientOptions } from "./index";
import { parseMessage } from "./parse";

const issue = loadFixture("issue.synthetic.eml");
const htmlOnly = loadFixture("html-only.synthetic.eml");
const noId = loadFixture("no-id.synthetic.eml");

describe("parseMessage", () => {
  it("reads the headers and takes the plain-text part", async () => {
    const msg = await parseMessage(issue, { uid: 7 });
    expect(msg).toMatchObject({
      uid: 7,
      messageId: "<issue-42.abc123@mail.example.com>",
      from: "Example Weekly <news@example.com>",
      subject: "Issue 42: Agents in production — what changed",
      date: Date.UTC(2026, 10, 18, 7, 30),
    });
    expect(msg.text).toMatch(/^View in browser: https:\/\/weekly\.example\.com\/p\/issue-42/);
    expect(msg.text).toMatch(/coding agents in production/);
    expect(msg.html).toMatch(/<h1>Issue 42<\/h1>/);
  });

  it("uses htmlToText when the message has no plain-text part", async () => {
    const msg = await parseMessage(htmlOnly, { uid: 8 });
    expect(msg.text).toMatch(/A new release of the document parser is out\./);
    expect(msg.text).toMatch(/Faster table extraction/);
    expect(msg.text).not.toMatch(/<p>|<li>/);
    expect(msg.from).toBe("Data Digest <digest@letters.example.com>");
  });

  it("odd message: no Message-ID, no date, no subject", async () => {
    const msg = await parseMessage(noId, { uid: 9, fallbackDate: 1234 });
    expect(msg.messageId).toBe("");
    expect(msg.subject).toBe("");
    expect(msg.date).toBe(1234);
    expect(msg.text).toMatch(/Only a body/);
    expect(msg.html).toBeUndefined();
  });
});

describe("createMailReader", () => {
  it("is null when IMAP_HOST, IMAP_USER, or IMAP_PASSWORD is absent", () => {
    expect(createMailReader(makeEnv())).toBeNull();
    expect(createMailReader(makeEnv({ IMAP_HOST: "imap.example.com", IMAP_USER: "u" }))).toBeNull();
    expect(createMailReader(makeEnv({ IMAP_USER: "u", IMAP_PASSWORD: "p" }))).toBeNull();
  });

  it("connects only to the host and port of the environment, with TLS", async () => {
    let seen: ImapClientOptions | undefined;
    const reader = createMailReader(
      makeEnv({ IMAP_HOST: "imap.example.com", IMAP_USER: "u", IMAP_PASSWORD: "p", IMAP_PORT: "1993", IMAP_MAILBOX: "Newsletters" }),
      (options) => {
        seen = options;
        return new FakeImap({ uidValidity: 5n, messages: [] });
      },
    );
    expect(reader).not.toBeNull();
    await reader!.list({ from: "news@example.com", sinceUid: null, limit: 10 });
    expect(seen).toMatchObject({ host: "imap.example.com", port: 1993, secure: true, servername: "imap.example.com", logger: false });
    expect(seen?.tls.rejectUnauthorized).toBe(true);
  });
});

/** A fake of the part of ImapFlow that the reader uses. */
class FakeImap implements ImapClientLike {
  calls: string[] = [];
  openOptions: { readOnly: boolean } | undefined;
  searchQuery: Record<string, unknown> | undefined;
  fetchRange: string | undefined;
  constructor(
    private box: {
      uidValidity: bigint;
      messages: Array<{ uid: number; source: string }>;
      failOn?: "connect" | "open" | "search";
      authFail?: boolean;
      searchExtra?: number[];
    },
  ) {}
  async connect() {
    this.calls.push("connect");
    if (this.box.failOn === "connect") {
      const error = Object.assign(new Error("Command failed"), this.box.authFail ? { authenticationFailed: true } : { code: "ECONNREFUSED" });
      throw error;
    }
  }
  async mailboxOpen(path: string, options: { readOnly: boolean }) {
    this.calls.push(`open:${path}`);
    this.openOptions = options;
    if (this.box.failOn === "open") throw Object.assign(new Error("Mailbox doesn't exist"), { serverResponseCode: "NONEXISTENT" });
    return { uidValidity: this.box.uidValidity };
  }
  async search(query: Record<string, unknown>) {
    this.calls.push("search");
    this.searchQuery = query;
    if (this.box.failOn === "search") throw new Error("socket closed");
    const range = typeof query.uid === "string" ? Number(query.uid.split(":")[0]) : 0;
    const uids = this.box.messages.map((m) => m.uid).filter((u) => u >= range);
    return [...uids, ...(this.box.searchExtra ?? [])];
  }
  async *fetch(range: string) {
    this.calls.push("fetch");
    this.fetchRange = range;
    const wanted = new Set(range.split(",").map(Number));
    for (const m of this.box.messages) {
      if (wanted.has(m.uid)) yield { uid: m.uid, source: Buffer.from(m.source), internalDate: new Date(Date.UTC(2026, 0, 1)) };
    }
  }
  async logout() {
    this.calls.push("logout");
  }
  close() {
    this.calls.push("close");
  }
}

const settings = { host: "imap.example.com", port: 993, user: "u", password: "p", mailbox: "INBOX" };

describe("createImapMailReader", () => {
  it("opens the mailbox read-only, searches by FROM and UID, and returns the newest first within the limit", async () => {
    const fake = new FakeImap({
      uidValidity: 77n,
      messages: [
        { uid: 10, source: issue },
        { uid: 11, source: htmlOnly },
        { uid: 12, source: noId },
      ],
      // "n:*" can return the highest UID even when it is lower than n.
      searchExtra: [3],
    });
    const reader = createImapMailReader(settings, () => fake);
    const result = await reader.list({ from: "news@example.com", subjectIncludes: "Issue", sinceUid: 9, limit: 2 });
    expect(fake.openOptions).toEqual({ readOnly: true });
    expect(fake.searchQuery).toEqual({ from: "news@example.com", subject: "Issue", uid: "10:*" });
    expect(fake.fetchRange).toBe("12,11");
    expect(result.uidValidity).toBe(77);
    expect(result.messages.map((m) => m.uid)).toEqual([12, 11]);
    expect(fake.calls).toEqual(["connect", "open:INBOX", "search", "fetch", "logout"]);
  });

  it("returns no message when the search finds none, and still logs out", async () => {
    const fake = new FakeImap({ uidValidity: 1n, messages: [] });
    const result = await createImapMailReader(settings, () => fake).list({ from: "x@example.com", sinceUid: null, limit: 10 });
    expect(result).toEqual({ uidValidity: 1, messages: [] });
    expect(fake.searchQuery).toEqual({ from: "x@example.com" });
    expect(fake.calls.at(-1)).toBe("logout");
  });

  it("maps a refused login to kind auth and closes the connection", async () => {
    const fake = new FakeImap({ uidValidity: 1n, messages: [], failOn: "connect", authFail: true });
    const error = await createImapMailReader(settings, () => fake)
      .list({ from: "x@example.com", sinceUid: null, limit: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).kind).toBe("auth");
    expect((error as MailError).message).not.toMatch(/\bp\b/);
    expect(fake.calls.at(-1)).toBe("logout");
  });

  it("maps a missing mailbox folder to kind not_found", async () => {
    const fake = new FakeImap({ uidValidity: 1n, messages: [], failOn: "open" });
    const error = await createImapMailReader({ ...settings, mailbox: "News" }, () => fake)
      .list({ from: "x@example.com", sinceUid: null, limit: 10 })
      .catch((e: unknown) => e);
    expect((error as MailError).kind).toBe("not_found");
    expect((error as MailError).message).toMatch(/"News"/);
  });

  it("maps a connection failure to kind network", async () => {
    const fake = new FakeImap({ uidValidity: 1n, messages: [], failOn: "search" });
    const error = await createImapMailReader(settings, () => fake)
      .list({ from: "x@example.com", sinceUid: null, limit: 10 })
      .catch((e: unknown) => e);
    expect((error as MailError).kind).toBe("network");
    expect((error as MailError).message).toMatch(/imap\.example\.com:993/);
    expect(fake.calls.at(-1)).toBe("logout");
  });
});
