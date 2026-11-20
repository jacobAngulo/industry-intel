import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MailError } from "@/lib/mail/errors";
import { parseMessage } from "@/lib/mail/parse";
import type { MailMessage, MailReader } from "@/lib/mail/types";
import { FakeHttp, loadFixture, makeConnectorContext, makeEnv } from "@/test/helpers";

import { ConnectorError, type ConnectorContext } from "../types";
import { connector, findViewInBrowserLink, messageToItem, parseSenderInput, senderAddress } from "./index";
import { platformOfPage, platformOfUrl } from "./index";

const MAIL_FIXTURES = fileURLToPath(new URL("../../mail/__fixtures__/", import.meta.url));
const eml = (name: string) => loadFixture(`${MAIL_FIXTURES}${name}`);

const mailboxEnv = makeEnv({ IMAP_HOST: "imap.example.com", IMAP_USER: "u", IMAP_PASSWORD: "p" });

function ctx(over: Partial<ConnectorContext> = {}) {
  return makeConnectorContext({ now: () => Date.UTC(2026, 10, 20), ...over });
}

async function expectError(promise: Promise<unknown>, kind: ConnectorError["kind"], text?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).kind).toBe(kind);
  if (text) expect((error as ConnectorError).message).toMatch(text);
}

describe("newsletter resolve", () => {
  it("a sender address gives the inbox variant, with a warning when the mailbox is not set", async () => {
    const http = new FakeHttp();
    for (const input of ["news@example.com", "mailto:News@Example.com", "Example News <news@example.com>"]) {
      const [c] = await connector.resolve(input, ctx({ http }), false);
      expect(c).toMatchObject({ type: "newsletter", config: { variant: "inbox", sender: "news@example.com" }, confidence: 0.9 });
      expect(c?.warnings?.[0]).toMatch(/IMAP_HOST/);
    }
    const [ready] = await connector.resolve("news@example.com", ctx({ http, env: mailboxEnv }), true);
    expect(ready?.warnings).toBeUndefined();
    expect(ready?.confidence).toBe(0.95);
    expect(http.requests).toHaveLength(0);
  });

  it("a Substack link gives the feed with one request", async () => {
    const http = new FakeHttp().on("https://importai.substack.com/feed", { text: loadFixture("substack-feed.xml") });
    const found = await connector.resolve("https://importai.substack.com/p/some-post", ctx({ http }), false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Import AI", confidence: 0.95, config: { variant: "feed", feedUrl: "https://importai.substack.com/feed" } });
    expect(found[0]?.description).toMatch(/^Substack newsletter\./);
    expect(http.urls).toEqual(["https://importai.substack.com/feed"]);
  });

  it("a Substack publication on its own domain: page marks, then the feed link", async () => {
    const http = new FakeHttp()
      .on("https://newsletter.pragmaticengineer.com/", { text: loadFixture("substack-custom-home.html") })
      .on("https://newsletter.pragmaticengineer.com/feed", { text: loadFixture("substack-feed.xml") });
    const found = await connector.resolve("https://newsletter.pragmaticengineer.com/", ctx({ http }), false);
    expect(found[0]).toMatchObject({ confidence: 0.92, config: { feedUrl: "https://newsletter.pragmaticengineer.com/feed" } });
  });

  it("a Ghost publication: the generator mark and the /rss/ feed", async () => {
    const http = new FakeHttp()
      .on("https://www.platformer.news/", { text: loadFixture("ghost-home.html") })
      .on("https://www.platformer.news/rss/", { text: loadFixture("ghost-rss.xml") });
    const found = await connector.resolve("platformer.news", ctx({ http: http.on("https://platformer.news/", { text: loadFixture("ghost-home.html"), url: "https://www.platformer.news/" }) }), false);
    expect(found[0]).toMatchObject({ name: "Platformer", config: { feedUrl: "https://www.platformer.news/rss/" } });
    expect(found[0]?.description).toMatch(/^Ghost newsletter/);
  });

  it("a beehiiv publication with no feed link: probes /feed first", async () => {
    const http = new FakeHttp()
      .on("https://www.therundown.ai/", { text: loadFixture("beehiiv-home.html") })
      .on("https://www.therundown.ai/feed", { text: loadFixture("beehiiv-feed.xml") });
    const found = await connector.resolve("https://www.therundown.ai/", ctx({ http }), false);
    expect(found[0]).toMatchObject({ name: "The Rundown AI", config: { feedUrl: "https://www.therundown.ai/feed" } });
    expect(http.urls).toEqual(["https://www.therundown.ai/", "https://www.therundown.ai/feed"]);
  });

  it("a Buttondown link gives /<name>/rss directly", async () => {
    const http = new FakeHttp().on("https://buttondown.com/hillelwayne/rss", { text: loadFixture("buttondown-rss.xml") });
    const found = await connector.resolve("https://buttondown.com/hillelwayne", ctx({ http }), false);
    expect(found[0]).toMatchObject({ name: "Computer Things", config: { feedUrl: "https://buttondown.com/hillelwayne/rss" } });
    expect(platformOfPage(loadFixture("buttondown-home.html"))).toBe("buttondown");
  });

  it("an address with no newsletter marks gives nothing unless the type is forced", async () => {
    const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`;
    const http = new FakeHttp()
      .on("https://example.com/", { text: html })
      .on("https://example.com/feed.xml", { text: loadFixture("substack-feed.xml") });
    expect(await connector.resolve("https://example.com/", ctx({ http }), false)).toEqual([]);
    const forced = await connector.resolve("example.com", ctx({ http }), true);
    expect(forced[0]).toMatchObject({ confidence: 0.6, config: { variant: "feed", feedUrl: "https://example.com/feed.xml" } });
  });

  it("returns [] for plain text and handles, with no request", async () => {
    const http = new FakeHttp();
    for (const input of ["agent workflows", "@chamath", "", "not an email@"]) {
      expect(await connector.resolve(input, ctx({ http }), false)).toEqual([]);
    }
    expect(http.requests).toHaveLength(0);
  });

  it("platformOfUrl and parseSenderInput", () => {
    expect(platformOfUrl(new URL("https://foo.beehiiv.com/p/x"))?.feedUrl).toBe("https://foo.beehiiv.com/feed");
    expect(platformOfUrl(new URL("https://foo.ghost.io/"))?.feedUrl).toBe("https://foo.ghost.io/rss/");
    expect(platformOfUrl(new URL("https://substack.com/@someone"))).toBeNull();
    expect(platformOfUrl(new URL("https://buttondown.email/pricing"))).toBeNull();
    expect(parseSenderInput("a@b")).toBeNull();
    expect(parseSenderInput("two words@example.com")).toBeNull();
    expect(senderAddress('"Name, Inc." <News@Example.com>')).toBe("news@example.com");
  });
});

describe("newsletter feed variant", () => {
  it("polls the feed like a blog, with the cursor of a feed", async () => {
    const http = new FakeHttp().on("https://buttondown.com/hillelwayne/rss", { text: loadFixture("buttondown-rss.xml"), etag: '"e1"' });
    const config = { variant: "feed" as const, feedUrl: "https://buttondown.com/hillelwayne/rss" };
    const first = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctx({ http }) });
    expect(first.items).toHaveLength(3);
    expect(first.items[0]?.kind).toBe("article");
    expect(first.cursor).toMatchObject({ etag: '"e1"' });
    const second = await connector.fetch({ config, cursor: first.cursor, mode: "poll", limit: 30, ctx: ctx({ http }) });
    expect(second.items).toEqual([]);
    expect(http.requests[1]?.etag).toBe('"e1"');
  });
});

/** A MailReader over a list of messages, with a call log. */
class FakeMailReader implements MailReader {
  calls: Array<Parameters<MailReader["list"]>[0]> = [];
  constructor(
    public uidValidity: number,
    public messages: MailMessage[],
    public error?: Error,
  ) {}
  async list(q: Parameters<MailReader["list"]>[0]) {
    this.calls.push(q);
    if (this.error) throw this.error;
    const found = this.messages
      .filter((m) => m.from.toLowerCase().includes(q.from))
      .filter((m) => q.sinceUid === null || m.uid > q.sinceUid)
      .sort((a, b) => b.uid - a.uid)
      .slice(0, q.limit);
    return { uidValidity: this.uidValidity, messages: found };
  }
}

function msg(uid: number, over: Partial<MailMessage> = {}): MailMessage {
  return {
    uid,
    messageId: `<m${uid}@mail.example.com>`,
    from: "Example Weekly <news@example.com>",
    subject: `Issue ${uid}`,
    date: Date.UTC(2026, 10, uid % 28),
    text: `Body of issue ${uid}.`,
    ...over,
  };
}

const inbox = { variant: "inbox" as const, sender: "news@example.com" };

describe("newsletter inbox variant", () => {
  it("first poll: the newest messages, and the cursor { uidValidity, lastUid }", async () => {
    const mail = new FakeMailReader(5, [msg(1), msg(2), msg(3)]);
    const result = await connector.fetch({ config: inbox, cursor: null, mode: "poll", limit: 30, ctx: ctx({ mail }) });
    expect(result.items.map((i) => i.externalId)).toEqual(["m3@mail.example.com", "m2@mail.example.com", "m1@mail.example.com"]);
    expect(result.items[0]).toMatchObject({ kind: "email", title: "Issue 3", author: "Example Weekly" });
    expect(result.cursor).toEqual({ uidValidity: 5, lastUid: 3 });
    expect(mail.calls[0]).toEqual({ from: "news@example.com", sinceUid: null, limit: 30 });
  });

  it("a later poll asks for UIDs above lastUid", async () => {
    const mail = new FakeMailReader(5, [msg(1), msg(2), msg(3), msg(4)]);
    const result = await connector.fetch({ config: inbox, cursor: { uidValidity: 5, lastUid: 2 }, mode: "poll", limit: 30, ctx: ctx({ mail }) });
    expect(mail.calls[0]?.sinceUid).toBe(2);
    expect(result.items.map((i) => i.title)).toEqual(["Issue 4", "Issue 3"]);
    expect(result.cursor).toEqual({ uidValidity: 5, lastUid: 4 });
  });

  it("no new message keeps the cursor", async () => {
    const mail = new FakeMailReader(5, [msg(1), msg(2)]);
    const result = await connector.fetch({ config: inbox, cursor: { uidValidity: 5, lastUid: 2 }, mode: "poll", limit: 30, ctx: ctx({ mail }) });
    expect(result.items).toEqual([]);
    expect(result.cursor).toEqual({ uidValidity: 5, lastUid: 2 });
  });

  it("a changed UIDVALIDITY starts again from the 10 newest messages", async () => {
    const mail = new FakeMailReader(9, Array.from({ length: 15 }, (_, i) => msg(i + 1)));
    const result = await connector.fetch({ config: inbox, cursor: { uidValidity: 5, lastUid: 40 }, mode: "poll", limit: 30, ctx: ctx({ mail }) });
    expect(mail.calls.map((c) => [c.sinceUid, c.limit])).toEqual([
      [40, 30],
      [null, 10],
    ]);
    expect(result.items).toHaveLength(10);
    expect(result.items[0]?.title).toBe("Issue 15");
    expect(result.cursor).toEqual({ uidValidity: 9, lastUid: 15 });
  });

  it("preview: the 10 newest messages of the sender, no cursor", async () => {
    const mail = new FakeMailReader(5, Array.from({ length: 12 }, (_, i) => msg(i + 1)));
    const result = await connector.fetch({ config: inbox, cursor: { uidValidity: 5, lastUid: 12 }, mode: "preview", limit: 30, ctx: ctx({ mail }) });
    expect(mail.calls[0]).toMatchObject({ sinceUid: null, limit: 10 });
    expect(result.items).toHaveLength(10);
    expect(result.cursor).toBeNull();
  });

  it("checks the sender address and the subject filter in code", async () => {
    const mail = new FakeMailReader(5, [
      msg(1, { from: "Fake <fakenews@example.com>" }),
      msg(2, { subject: "Weekly digest: agents" }),
      msg(3, { subject: "Sponsored message" }),
    ]);
    const config = { ...inbox, subjectIncludes: "DIGEST" };
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctx({ mail }) });
    expect(mail.calls[0]?.subjectIncludes).toBe("DIGEST");
    expect(result.items.map((i) => i.title)).toEqual(["Weekly digest: agents"]);
    // The cursor moves past the messages that the filter dropped.
    expect(result.cursor).toEqual({ uidValidity: 5, lastUid: 3 });
  });

  it("no mailbox: needs_credentials with the variable names", async () => {
    await expectError(connector.fetch({ config: inbox, cursor: null, mode: "poll", limit: 30, ctx: ctx() }), "needs_credentials", /IMAP_HOST/);
    expect(connector.needs(makeEnv(), inbox)?.code).toBe("mailbox");
    expect(connector.needs(mailboxEnv, inbox)).toBeNull();
    expect(connector.needs(makeEnv(), { variant: "feed", feedUrl: "https://x.example.com/feed" })).toBeNull();
  });

  it.each([
    [new MailError("auth", "The mailbox refused the user name or the password (IMAP_USER, IMAP_PASSWORD)."), "needs_credentials"],
    [new MailError("not_found", 'The mailbox folder "X" does not exist (IMAP_MAILBOX).'), "not_found"],
    [new MailError("network", "The app could not read the mailbox."), "network"],
    [new Error("boom"), "network"],
  ] as const)("maps the reader error %s", async (error, kind) => {
    const mail = new FakeMailReader(1, [], error);
    await expectError(connector.fetch({ config: inbox, cursor: null, mode: "poll", limit: 30, ctx: ctx({ mail }) }), kind);
  });

  it("odd cursor: a feed cursor or garbage counts as no cursor", async () => {
    const mail = new FakeMailReader(5, [msg(1)]);
    const result = await connector.fetch({ config: inbox, cursor: { seenIds: [] } as never, mode: "poll", limit: 30, ctx: ctx({ mail }) });
    expect(mail.calls[0]?.sinceUid).toBeNull();
    expect(result.cursor).toEqual({ uidValidity: 5, lastUid: 1 });
  });
});

describe("email to item", () => {
  it("maps a parsed .eml: Message-ID, subject, text, the view-in-browser link, and content links", async () => {
    const item = messageToItem(await parseMessage(eml("issue.synthetic.eml"), { uid: 42 }));
    expect(item).toMatchObject({
      externalId: "issue-42.abc123@mail.example.com",
      title: "Issue 42: Agents in production — what changed",
      author: "Example Weekly",
      kind: "email",
      publishedAt: Date.UTC(2026, 10, 18, 7, 30),
      url: "https://weekly.example.com/p/issue-42?utm_source=email",
      meta: { sender: "news@example.com", uid: 42 },
    });
    expect(item.text).toMatch(/coding agents in production/);
    expect(item.links).toContain("https://blog.example.net/evals");
    expect(item.links?.some((l) => /unsubscribe/.test(l))).toBe(false);
    expect(item.links?.length ?? 0).toBeLessThanOrEqual(10);
  });

  it("an HTML-only email: the text from the HTML and the 'View this post on the web' link", async () => {
    const item = messageToItem(await parseMessage(eml("html-only.synthetic.eml"), { uid: 7 }));
    expect(item.url).toBe("https://letters.example.com/p/data-digest-7");
    expect(item.text).toMatch(/Faster table extraction/);
    expect(item.author).toBe("Data Digest");
  });

  it("an email with no Message-ID gets a stable hash id and a placeholder title", async () => {
    const parsed = await parseMessage(eml("no-id.synthetic.eml"), { uid: 3, fallbackDate: 0 });
    const a = messageToItem(parsed);
    const b = messageToItem(parsed);
    expect(a.externalId).toMatch(/^sha:[0-9a-f]{64}$/);
    expect(a.externalId).toBe(b.externalId);
    expect(a.title).toBe("(no subject)");
    expect(a.publishedAt).toBeUndefined();
  });

  it("finds the view-in-browser link in several forms", () => {
    expect(findViewInBrowserLink(`<a href='https://a.example.com/x'>View&nbsp;online</a>`, "")).toBe("https://a.example.com/x");
    expect(findViewInBrowserLink(`<a href="https://a.example.com/web">Read it online</a>`, "")).toBe("https://a.example.com/web");
    expect(findViewInBrowserLink(`<a href="mailto:x@example.com">View in browser</a>`, "")).toBeUndefined();
    expect(findViewInBrowserLink(undefined, "View this email in your browser\n<https://b.example.com/e/1>\nHello")).toBe("https://b.example.com/e/1");
    expect(findViewInBrowserLink(undefined, "View this post on the web at https://c.example.com/p/2.")).toBe("https://c.example.com/p/2");
    expect(findViewInBrowserLink(`<a href="https://a.example.com/">Home</a>`, "Hello")).toBeUndefined();
    expect(findViewInBrowserLink(undefined, "")).toBeUndefined();
  });
});
