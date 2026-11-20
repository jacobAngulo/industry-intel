import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { splitSections } from "@/lib/text";
import { FakeHttp, loadFixture, makeConnectorContext } from "@/test/helpers";

import { docsConfigSchema, type DocsConfig } from "../configs";
import { ConnectorError, type RawItem } from "../types";
import { leadingDate, isVersionHeading } from "./dates";
import { changedCharacters, changedParts, isMinorEdit } from "./diff";
import { analyzeSections, changelogEntries, detectMode } from "./entries";
import { connector, PAGE_PREVIEW_NOTE, type DocsCursor } from "./index";
import { revealDeferredContent } from "./page";

const TEXT_FIXTURES = fileURLToPath(new URL("../../text/__fixtures__/", import.meta.url));
const foundry = loadFixture("foundry-whats-new.html", TEXT_FIXTURES);
const cursorPage = loadFixture("cursor-changelog.html", TEXT_FIXTURES);
const fx = (name: string) => loadFixture(name);

const FOUNDRY = "https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry";
const CURSOR = "https://cursor.com/changelog";
const ANTHROPIC = "https://www.anthropic.com/news";
const NOW = Date.parse("2026-11-20T12:00:00Z");

function cfg(url: string, values: Partial<DocsConfig> = {}): DocsConfig {
  return docsConfigSchema.parse({ url, ...values });
}

function ctxWith(http: FakeHttp) {
  return makeConnectorContext({ http, now: () => NOW });
}

/** A FakeHttp that serves the given pages one after the other at one address. */
function pages(url: string) {
  const http = new FakeHttp();
  let current: { text: string; etag?: string } = { text: "" };
  http.on(url, () => ({ text: current.text, headers: { "content-type": "text/html; charset=utf-8" }, ...(current.etag ? { etag: current.etag } : {}) }));
  return {
    http,
    serve(text: string, etag?: string) {
      current = etag ? { text, etag } : { text };
    },
  };
}

async function poll(config: DocsConfig, cursor: DocsCursor | null, http: FakeHttp, limit = 30) {
  return connector.fetch({ config, cursor, mode: "poll", limit, ctx: ctxWith(http) });
}

/** Polls the first page (baseline), then the second page; returns the second result. */
async function change(url: string, before: string, after: string, values: Partial<DocsConfig> = {}) {
  const site = pages(url);
  site.serve(before);
  const first = await poll(cfg(url, values), null, site.http);
  site.serve(after);
  const second = await poll(cfg(url, values), first.cursor, site.http);
  return { first, second };
}

async function expectConnectorError(promise: Promise<unknown>, kind: ConnectorError["kind"], pattern?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).kind).toBe(kind);
  if (pattern) expect((error as ConnectorError).message).toMatch(pattern);
}

function checkItems(items: RawItem[]) {
  for (const item of items) {
    expect(item.kind).toBe("doc_change");
    expect(item.text.length).toBeLessThanOrEqual(20_000);
    expect(item.text).not.toMatch(/<\/?(?:p|div|a|span|li|ul|ol|h[1-6]|br|time|article)\b[^>]*>/i);
    expect((item.links ?? []).length).toBeLessThanOrEqual(10);
    for (const link of item.links ?? []) expect(link).toMatch(/^https?:\/\//);
    expect(item.externalId).toMatch(/^[0-9a-f]{32}(?::[0-9a-f]{16})?$/);
  }
}

describe("dates and versions", () => {
  it.each([
    ["2026-11-19", "2026-11-19"],
    ["2026-11-19T08:00:00Z", "2026-11-19"],
    ["Nov 6, 2026 · Changelog", "2026-11-06"],
    ["November 19th, 2026", "2026-11-19"],
    ["19 November 2026", "2026-11-19"],
    ["Sept 3, 2026", "2026-09-03"],
    ["November 2026", "2026-11-01"],
    ["2026/11/19 - release", "2026-11-19"],
  ])("%s", (text, day) => {
    expect(new Date(leadingDate(text)!).toISOString().slice(0, 10)).toBe(day);
  });

  it.each(["Welcome", "What's new in August 2026", "1.2 Install", "2026", "Feb 30, 2026", "Novembers 2026", "2026-11-19abc", ""])(
    "not a date: %s",
    (text) => {
      expect(leadingDate(text)).toBeUndefined();
    },
  );

  it.each(["1.4.2", "v2.1", "v3", "Version 3.1", "Release 12", "2.1 — Agent improvements", "1.4.0-beta.2", "Claude Code 2.0.5", "Cursor v2.1", "3.0.1 (2026-11-19)"])(
    "version: %s",
    (text) => {
      expect(isVersionHeading(text)).toBe(true);
    },
  );

  it.each(["1.2 Install", "Introducing Claude Haiku 5.5", "New articles", "Python 3.12 support is here", "Step 2", ""])("not a version: %s", (text) => {
    expect(isVersionHeading(text)).toBe(false);
  });
});

describe("diff", () => {
  it("minor edits: fewer than 40 characters and no number changed", () => {
    expect(isMinorEdit("Build with runtime components", "Build using runtime components")).toBe(true);
    expect(isMinorEdit("Hello, World!", "hello world")).toBe(true);
    expect(isMinorEdit("Updates for August 2026", "Updates for August 2027")).toBe(false);
    expect(isMinorEdit("Limit is 10 requests", "Limit is 100 requests")).toBe(false);
    expect(isMinorEdit("Short text", "Short text with a new sentence that is clearly longer than forty characters")).toBe(false);
    // A moved number is not a changed number.
    expect(isMinorEdit("Announcements Nov 9 2026 Our models", "Our models Announcements Nov 9 2026")).toBe(true);
  });

  it("changedCharacters counts the words that differ", () => {
    expect(changedCharacters("a b c", "a b c")).toBe(0);
    expect(changedCharacters("build with runtime", "build using runtime")).toBe(9);
    expect(changedCharacters("", "new words")).toBe(8);
  });

  it("changedParts: the new lines with the first line of their block as context, and removed lines", () => {
    const old = "- Foundry Agent Service\n  - Article A\n  - Article B\n- Models\n  - Article C";
    const parts = changedParts(old, ["Foundry Agent Service\n  - Article A\n  - Article New\n  - Article B", "Models\n  - Article C"]);
    expect(parts.added).toEqual(["Foundry Agent Service\n  - Article New"]);
    expect(parts.removed).toEqual([]);
    const gone = changedParts(old, ["Foundry Agent Service\n  - Article A", "Models\n  - Article C"]);
    expect(gone.added).toEqual([]);
    expect(gone.removed).toEqual(["Article B"]);
  });
});

describe("sections, mode, and entries", () => {
  it("Foundry \"What's new\": no dated section -> page", () => {
    const analyzed = analyzeSections(splitSections(foundry));
    expect(analyzed.map((a) => a.section.path)).toEqual([
      "What's new in Microsoft Foundry?",
      "What's new in Microsoft Foundry? > New articles",
      "What's new in Microsoft Foundry? > Updated articles",
    ]);
    expect(detectMode(analyzed)).toBe("page");
  });

  it("Cursor changelog: titled entries with a datetime -> changelog; one entry for each article with its sub-sections", () => {
    const analyzed = analyzeSections(splitSections(cursorPage));
    expect(detectMode(analyzed)).toBe("changelog");
    const entries = changelogEntries(analyzed);
    expect(entries.map((e) => e.title)).toEqual([
      "Voice Chat with Agents",
      "Build Live Apps in Cursor",
      "Agent SDK",
      "Cloud Agent Canvases and Environment Improvements",
      "Origin App Marketplace",
    ]);
    expect(new Date(entries[0]!.publishedAt!).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(entries[0]!.text).toMatch(/^Nov 6, 2026 · Changelog\n\nYou can now talk/);
    expect(entries[0]!.text).toContain("Start a call\n\nWhen the agent is idle");
    expect(entries[3]!.text).toContain("Environments API");
  });

  it("Anthropic news (trimmed live page): date lines, a list shown by a script -> changelog, no duplicates", () => {
    const html = fx("anthropic-news.html");
    // Without the hidden list only the featured block is there.
    const hidden = changelogEntries(analyzeSections(splitSections(html))).map((e) => e.title);
    expect(hidden).not.toContain("Anthropic prices initial public offering");
    const analyzed = analyzeSections(splitSections(revealDeferredContent(html)));
    expect(detectMode(analyzed)).toBe("changelog");
    const entries = changelogEntries(analyzed);
    const titles = entries.map((e) => e.title);
    expect(titles[0]).toBe("Anthropic prices initial public offering");
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).not.toContain("News");
    expect(titles).toContain("Introducing Claude Haiku 5.5");
    const times = entries.map((e) => e.publishedAt!);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("date headings group entries: sub-headings, or list items when there is no sub-heading", () => {
    const html = `<main><h1>Release notes</h1>
      <h2>2026-11-19</h2><h3>New agents API</h3><p>Agents can call tools in parallel.</p><h3>Fixes</h3><p>The retry bug is fixed.</p>
      <h2>November 12, 2026</h2><ul><li>Added the batch endpoint for long jobs.</li><li>Removed the v1 search API.</li></ul>
      <h2>v1.4.0</h2><p>Faster start.</p></main>`;
    const analyzed = analyzeSections(splitSections(html));
    expect(detectMode(analyzed)).toBe("changelog");
    const entries = changelogEntries(analyzed);
    expect(entries.map((e) => e.title)).toEqual([
      "2026-11-19 — New agents API",
      "2026-11-19 — Fixes",
      "November 12, 2026: Added the batch endpoint for long jobs.",
      "November 12, 2026: Removed the v1 search API.",
      "v1.4.0: Faster start.",
    ]);
    expect(entries[0]!.key).toBe("2026-11-19 > New agents API");
    expect(entries[4]!.publishedAt).toBeUndefined();
  });
});

describe("resolve", () => {
  it("a documentation page: a page candidate named from the page title", async () => {
    const http = new FakeHttp().on(FOUNDRY, { text: foundry, headers: { "content-type": "text/html" } });
    const [c, ...rest] = await connector.resolve(FOUNDRY, ctxWith(http), false);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      type: "docs",
      name: "Microsoft Foundry docs: What's new for August 2026 - Microsoft Foundry",
      description: "Documentation page with 3 sections. New and changed sections become items.",
      url: FOUNDRY,
      confidence: 0.6,
    });
    expect(c?.config).toEqual(cfg(FOUNDRY, { mode: "auto", ignoreMinorEdits: true }));
    expect(c?.warnings).toBeUndefined();
  });

  it("a changelog page, also from an address with no scheme", async () => {
    const http = new FakeHttp().on(CURSOR, { text: cursorPage });
    const [c] = await connector.resolve("cursor.com/changelog", ctxWith(http), false);
    expect(c).toMatchObject({
      name: "What's New in Cursor — Latest Updates & Release Notes",
      description: "Changelog page with 5 dated entries. New entries become items.",
      confidence: 0.75,
    });
  });

  it("a page that has a feed: a lower candidate with a warning", async () => {
    const html = `<html><head><title>Example blog</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><main><h1>Posts</h1><p>Text of the page that is long enough.</p></main></body></html>`;
    const http = new FakeHttp().on("https://blog.example.com/", { text: html });
    const [c] = await connector.resolve("https://blog.example.com/", ctxWith(http), false);
    expect(c?.confidence).toBe(0.35);
    expect(c?.warnings?.[0]).toMatch(/has a feed/);
    expect(c?.name).toBe("Example blog");
  });

  it("follows the final address after a redirect", async () => {
    const http = new FakeHttp().on("https://example.com/docs", { text: foundry, url: "https://example.com/docs/whats-new" });
    const [c] = await connector.resolve("https://example.com/docs#top", ctxWith(http), false);
    expect(c?.url).toBe("https://example.com/docs/whats-new");
    expect((c?.config as DocsConfig).url).toBe("https://example.com/docs/whats-new");
  });

  it("a feed, a missing page, a PDF, or a page with no text", async () => {
    const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
    const http = new FakeHttp()
      .on("https://example.com/feed.xml", { text: feed, headers: { "content-type": "application/rss+xml" } })
      .on("https://example.com/missing", { status: 404, text: "Not found" })
      .on("https://example.com/file.pdf", { text: "%PDF-1.7", headers: { "content-type": "application/pdf" } })
      .on("https://example.com/empty", { text: "<html><body></body></html>" });
    const ctx = ctxWith(http);
    expect(await connector.resolve("https://example.com/feed.xml", ctx, false)).toEqual([]);
    expect(await connector.resolve("https://example.com/missing", ctx, true)).toEqual([]);
    expect(await connector.resolve("https://example.com/file.pdf", ctx, false)).toEqual([]);
    const [empty] = await connector.resolve("https://example.com/empty", ctx, false);
    expect(empty?.confidence).toBe(0.3);
    expect(empty?.warnings?.[0]).toMatch(/CSS selector/);
  });

  it("a page that does not answer: nothing, or an unchecked candidate when the person chose the type", async () => {
    const http = new FakeHttp()
      .on("https://slow.example.com/docs", { error: new HttpError("timeout", "t") })
      .on("https://shy.example.com/docs", { status: 403, text: "no" })
      .on("https://private.example.com/", { error: new HttpError("blocked_address", "x") });
    const ctx = ctxWith(http);
    expect(await connector.resolve("https://slow.example.com/docs", ctx, false)).toEqual([]);
    const [slow] = await connector.resolve("https://slow.example.com/docs", ctx, true);
    expect(slow).toMatchObject({ type: "docs", confidence: 0.3, warnings: ["The page did not answer in time."] });
    const [shy] = await connector.resolve("https://shy.example.com/docs", ctx, true);
    expect(shy?.warnings).toEqual(["The site refused the request (403)."]);
    expect(await connector.resolve("https://private.example.com/", ctx, true)).toEqual([]);
  });

  it("input that is not a page address makes no request", async () => {
    const http = new FakeHttp();
    for (const input of ["coding agents", "@chamath", "anthropics/claude-code", "news@example.com", "ftp://example.com/x", "mailto:a@b.co", "r/LocalLLaMA", ""]) {
      expect(await connector.resolve(input, ctxWith(http), false)).toEqual([]);
    }
    expect(http.requests).toHaveLength(0);
  });

  it("addresses of other types give no docs candidate unless the person chose the type", async () => {
    const http = new FakeHttp().onPrefix("https://", { text: foundry });
    const ctx = ctxWith(http);
    for (const input of [
      "https://x.com/chamath",
      "https://www.youtube.com/@anthropic-ai",
      "https://www.reddit.com/r/LocalLLaMA/",
      "https://github.com/anthropics/claude-code",
      "https://github.com/openai/codex/releases",
      "https://news.ycombinator.com/",
    ]) {
      expect(await connector.resolve(input, ctx, false)).toEqual([]);
    }
    expect(http.requests).toHaveLength(0);
    expect(await connector.resolve("https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md", ctx, false)).toHaveLength(1);
    expect(await connector.resolve("https://github.com/anthropics/claude-code", ctx, true)).toHaveLength(1);
  });
});

describe("fetch: page mode (Foundry)", () => {
  it("the first snapshot is a baseline: no item; the cursor holds the sections and the ETag", async () => {
    const http = new FakeHttp().on(FOUNDRY, { text: foundry, etag: '"f1"', lastModified: "Thu, 05 Nov 2026 04:05:14 GMT" });
    const result = await poll(cfg(FOUNDRY), null, http);
    expect(result.items).toEqual([]);
    expect(result.cursor).toMatchObject({ mode: "page", etag: '"f1"', lastModified: "Thu, 05 Nov 2026 04:05:14 GMT", seenEntryIds: [] });
    expect(result.cursor?.sections.map((s) => s.path)).toEqual([
      "What's new in Microsoft Foundry?",
      "What's new in Microsoft Foundry? > New articles",
      "What's new in Microsoft Foundry? > Updated articles",
    ]);
    for (const s of result.cursor!.sections) {
      expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("a later poll sends the ETag; 304 gives no item and the same cursor", async () => {
    const http = new FakeHttp().on(FOUNDRY, { text: foundry, etag: '"f1"' });
    const first = await poll(cfg(FOUNDRY), null, http);
    const second = await poll(cfg(FOUNDRY), first.cursor, http);
    expect(http.requests[1]?.etag).toBe('"f1"');
    expect(second).toEqual({ items: [], cursor: first.cursor });
  });

  it("an unchanged page (200 again) gives no item", async () => {
    const { second } = await change(FOUNDRY, foundry, foundry);
    expect(second.items).toEqual([]);
  });

  it("a new block in \"New articles\": one item with the new line, its context, its link, and before / after", async () => {
    const { first, second } = await change(FOUNDRY, foundry, fx("foundry-new-article.html"));
    expect(second.items).toHaveLength(1);
    const item = second.items[0]!;
    checkItems(second.items);
    expect(item.title).toBe("Updated: What's new in Microsoft Foundry? > New articles");
    expect(item.text).toBe("Foundry Agent Service\n  - Use hosted agents with private networking (preview)");
    expect(item.url).toBe(FOUNDRY);
    expect(item.links).toEqual(["https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/private-network-agents"]);
    expect(item.meta).toMatchObject({ change: "changed_section", path: "What's new in Microsoft Foundry? > New articles" });
    const meta = item.meta as { before: string; after: string };
    expect(meta.before).toBe(first.cursor!.sections[1]!.text);
    expect(meta.after).toContain("Use hosted agents with private networking (preview)");
    expect(item.publishedAt).toBeUndefined();
    // The next poll of the same page gives nothing.
    const site = pages(FOUNDRY);
    site.serve(fx("foundry-new-article.html"));
    expect((await poll(cfg(FOUNDRY), second.cursor, site.http)).items).toEqual([]);
  });

  it("cosmetic edits give no item", async () => {
    const { first, second } = await change(FOUNDRY, foundry, fx("foundry-cosmetic.html"));
    expect(second.items).toEqual([]);
    expect(second.cursor?.sections.map((s) => s.hash)).toEqual(first.cursor?.sections.map((s) => s.hash));
  });

  it("a changed number is never minor", async () => {
    const { second } = await change(FOUNDRY, foundry, fx("foundry-number.html"));
    expect(second.items.map((i) => i.title)).toEqual(["Updated: What's new in Microsoft Foundry?"]);
    expect(second.items[0]?.text).toBe("Welcome! This article highlights key updates for Microsoft Foundry in August 2027.");
  });

  it("ignoreMinorEdits drops a small wording edit; the edits add up against the old text", async () => {
    const minor = fx("foundry-minor-wording.html");
    const { first, second } = await change(FOUNDRY, foundry, minor);
    expect(second.items).toEqual([]);
    expect(second.cursor?.sections[2]).toEqual(first.cursor?.sections[2]);
    // A second small edit of the same section: together more than 40 characters.
    const more = minor.replace("Run a hosted agent locally", "Run and debug a hosted agent on your own machine");
    const site = pages(FOUNDRY);
    site.serve(more);
    const third = await poll(cfg(FOUNDRY), second.cursor, site.http);
    expect(third.items).toHaveLength(1);
    expect(third.items[0]?.text).toBe(
      "Foundry Agent Service\n  - Build using runtime components in Foundry Agent Service\n  - Run and debug a hosted agent on your own machine",
    );
  });

  it("ignoreMinorEdits off: a small wording edit is an item", async () => {
    const { second } = await change(FOUNDRY, foundry, fx("foundry-minor-wording.html"), { ignoreMinorEdits: false });
    expect(second.items.map((i) => i.title)).toEqual(["Updated: What's new in Microsoft Foundry? > Updated articles"]);
  });

  it("a new section is an item with all its text", async () => {
    const { second } = await change(FOUNDRY, foundry, fx("foundry-new-section.html"));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      title: "New section: What's new in Microsoft Foundry? > Deprecations",
      text: "The classic agents API retires on 31 March 2027. Move to the new Agent Service API before that date.",
    });
    expect(second.items[0]?.meta).toMatchObject({ change: "new_section", before: "" });
  });

  it("more than 8 changed sections: one \"Large revision\" item with the list of paths", async () => {
    const { second } = await change(CURSOR, cursorPage, fx("cursor-rewrite.html"), { mode: "page" });
    expect(second.items).toHaveLength(1);
    const item = second.items[0]!;
    checkItems([item]);
    expect(item.title).toBe("Large revision of What's New in Cursor — Latest Updates & Release Notes");
    expect(item.text).toMatch(/^\d+ sections are new or changed:\n- New Voice Chat with Agents\n/);
    expect((item.meta as { paths: string[] }).paths.length).toBeGreaterThan(8);
    expect(item.meta).toMatchObject({ change: "large_revision" });
  });

  it("removed text only: the item lists the removed lines", async () => {
    const less = foundry.replace(/<li><a [^>]*>Deploy a steerable agent \(preview\)<\/a><\/li>/, "");
    // Fewer than 40 characters: a minor edit unless ignoreMinorEdits is off.
    expect((await change(FOUNDRY, foundry, less)).second.items).toEqual([]);
    const { second } = await change(FOUNDRY, foundry, less, { ignoreMinorEdits: false });
    expect(second.items[0]?.text).toBe("Removed:\n- Deploy a steerable agent (preview)");
  });

  it("preview: the first sections as samples with the note, no cursor", async () => {
    const http = new FakeHttp().on(FOUNDRY, { text: foundry });
    const result = await connector.fetch({ config: cfg(FOUNDRY), cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http) });
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(3);
    for (const item of result.items) expect(item.meta).toMatchObject({ sample: true, note: PAGE_PREVIEW_NOTE });
    expect(result.items[1]?.title).toBe("What's new in Microsoft Foundry? > New articles");
    expect(result.items[1]?.links?.length).toBe(10);
  });
});

describe("fetch: changelog mode (Cursor)", () => {
  it("the first snapshot emits the 3 newest entries and stores all entries", async () => {
    const http = new FakeHttp().on(CURSOR, { text: cursorPage, etag: 'W/"c1"' });
    const result = await poll(cfg(CURSOR), null, http);
    checkItems(result.items);
    expect(result.items.map((i) => i.title)).toEqual(["Voice Chat with Agents", "Build Live Apps in Cursor", "Agent SDK"]);
    const first = result.items[0]!;
    expect(first.publishedAt).toBe(Date.parse("2026-11-06T00:00:00Z"));
    // The heading links to the article: that is the address of the item.
    expect(first.url).toBe("https://cursor.com/changelog/voice-chat");
    expect(first.links?.[0]).toBe("https://cursor.com/changelog/voice-chat");
    expect(first.meta).toMatchObject({ change: "new_entry", path: "Voice Chat with Agents" });
    expect(result.cursor?.mode).toBe("changelog");
    expect(result.cursor?.sections).toHaveLength(5);
    expect(result.cursor?.seenEntryIds).toHaveLength(5);
    expect(result.cursor?.sections[0]?.path).toBe(`Voice Chat with Agents #${first.externalId}`);
    for (const item of result.items) expect(item.url).toMatch(/^https:\/\/cursor\.com\/changelog\/[a-z-]+$/);
  });

  it("a new entry: one item", async () => {
    const { second } = await change(CURSOR, cursorPage, fx("cursor-new-entry.html"));
    expect(second.items.map((i) => i.title)).toEqual(["Agent Review in the Editor"]);
    const item = second.items[0]!;
    expect(item.text).toMatch(/^Nov 19, 2026 · Changelog\n\nAgents can now review a pull request/);
    expect(item.text).toContain("How to start\n\nOpen a pull request");
    expect(item.publishedAt).toBe(Date.parse("2026-11-19T00:00:00Z"));
    expect(item.url).toBe("https://cursor.com/changelog/agent-review");
    expect(item.links).toEqual(["https://cursor.com/changelog/agent-review"]);
    expect(second.cursor?.sections).toHaveLength(6);
  });

  it("a changed old entry: one item with the new part, before / after, and the id + content hash", async () => {
    const { first, second } = await change(CURSOR, cursorPage, fx("cursor-changed-entry.html"));
    expect(second.items).toHaveLength(1);
    const item = second.items[0]!;
    expect(item.title).toBe("Updated: Agent SDK");
    expect(item.text).toBe("Update: agents built with the SDK can now call MCP servers that need OAuth sign-in.");
    const agentSdk = first.items.find((i) => i.title === "Agent SDK")!;
    expect(item.externalId.startsWith(`${agentSdk.externalId}:`)).toBe(true);
    expect(item.meta).toMatchObject({ change: "changed_entry", path: "Agent SDK" });
    expect((item.meta as { before: string }).before).not.toContain("OAuth");
    expect((item.meta as { after: string }).after).toContain("OAuth");
  });

  it("a cosmetic edit of an entry gives no item", async () => {
    const { second } = await change(CURSOR, cursorPage, fx("cursor-cosmetic-entry.html"));
    expect(second.items).toEqual([]);
  });

  it("a full rewrite: each renamed entry is new; the limit caps the items", async () => {
    const { second } = await change(CURSOR, cursorPage, fx("cursor-rewrite.html"));
    expect(second.items.map((i) => i.title)).toEqual([
      "New Voice Chat with Agents",
      "New Build Live Apps in Cursor",
      "New Agent SDK",
      "New Cloud Agent Canvases and Environment Improvements",
      "New Origin App Marketplace",
    ]);
    const site = pages(CURSOR);
    site.serve(cursorPage);
    const base = await poll(cfg(CURSOR), null, site.http);
    site.serve(fx("cursor-rewrite.html"));
    expect((await poll(cfg(CURSOR), base.cursor, site.http, 2)).items).toHaveLength(2);
  });

  it("an entry that left the snapshot but is in seenEntryIds is not new again", async () => {
    const site = pages(CURSOR);
    site.serve(cursorPage);
    const base = await poll(cfg(CURSOR), null, site.http);
    const cursor: DocsCursor = { ...base.cursor!, sections: base.cursor!.sections.slice(0, 1) };
    const again = await poll(cfg(CURSOR), cursor, site.http);
    expect(again.items).toEqual([]);
  });

  it("preview: the 5 newest entries, no cursor", async () => {
    const http = new FakeHttp().on(CURSOR, { text: cursorPage });
    const result = await connector.fetch({ config: cfg(CURSOR), cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http) });
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(5);
    expect(result.items[0]?.meta).not.toHaveProperty("sample");
  });

  it("Anthropic news: a changelog with the list that a script shows", async () => {
    const http = new FakeHttp().on(ANTHROPIC, { text: fx("anthropic-news.html") });
    const result = await poll(cfg(ANTHROPIC), null, http);
    expect(result.cursor?.mode).toBe("changelog");
    expect(result.items.map((i) => i.title)).toEqual([
      "Anthropic prices initial public offering",
      "Anthropic launches roadshow for proposed initial public offering",
      "Introducing Claude Fable 5.2 and Claude Mythos 5.2",
    ]);
    expect(result.items[0]?.url).toBe("https://www.anthropic.com/news/anthropic-prices-initial-public-offering");
    expect(result.items[0]?.publishedAt).toBe(Date.parse("2026-11-18T00:00:00Z"));
  });
});

describe("fetch: modes", () => {
  it("auto keeps the mode of the cursor; a fixed mode that differs from the cursor starts a new baseline", async () => {
    const site = pages(CURSOR);
    site.serve(cursorPage);
    const asPage = await poll(cfg(CURSOR, { mode: "page" }), null, site.http);
    expect(asPage.cursor?.mode).toBe("page");
    expect(asPage.items).toEqual([]);
    // "auto" now: the stored mode (page) stays.
    const auto = await poll(cfg(CURSOR, { mode: "auto" }), asPage.cursor, site.http);
    expect(auto.cursor?.mode).toBe("page");
    expect(auto.items).toEqual([]);
    // A fixed changelog mode: a new baseline with the 3 newest entries.
    const fixed = await poll(cfg(CURSOR, { mode: "changelog" }), asPage.cursor, site.http);
    expect(fixed.cursor?.mode).toBe("changelog");
    expect(fixed.items).toHaveLength(3);
  });

  it("the selector limits the page to one element", async () => {
    const http = new FakeHttp().on(FOUNDRY, { text: foundry });
    const result = await connector.fetch({
      config: cfg(FOUNDRY, { selector: "#updated-articles + ul" }), cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Microsoft Foundry docs: What's new for August 2026 - Microsoft Foundry");
    expect(result.items[0]?.text).toContain("azure.yaml reference for hosted agents");
    expect(result.items[0]?.text).not.toContain("Agent optimizer cost");
  });
});

describe("fetch: limits of the cursor", () => {
  it("at most 300 sections of at most 4000 characters, and at most 500 entry ids", async () => {
    const long = "word ".repeat(1200);
    const items = Array.from({ length: 600 }, (_, n) => `<li>Change number ${n} of the service: ${n % 7 === 0 ? long : "short note"}</li>`).join("");
    const html = `<main><h1>Changes</h1><h2>2026-11-19</h2><ul>${items}</ul><h2>2026-11-18</h2><p>One</p><h2>2026-11-17</h2><p>Two</p></main>`;
    const http = new FakeHttp().on("https://example.com/changes", { text: html });
    const result = await poll(cfg("https://example.com/changes"), null, http);
    expect(result.cursor?.mode).toBe("changelog");
    expect(result.cursor?.sections).toHaveLength(300);
    expect(result.cursor?.seenEntryIds).toHaveLength(500);
    for (const s of result.cursor!.sections) expect(s.text.length).toBeLessThanOrEqual(4000);
    expect(result.items).toHaveLength(3);

    const sections = Array.from({ length: 350 }, (_, n) => `<h2>Topic ${n}</h2><p>${n === 1 ? long : `Text of topic ${n}.`}</p>`).join("");
    const http2 = new FakeHttp().on("https://example.com/big", { text: `<main>${sections}</main>` });
    const page = await poll(cfg("https://example.com/big"), null, http2);
    expect(page.cursor?.mode).toBe("page");
    expect(page.cursor?.sections).toHaveLength(300);
    expect(page.cursor!.sections[1]!.text.length).toBeLessThanOrEqual(4000);
    // A long section with the same text again is not a change.
    const again = await poll(cfg("https://example.com/big"), page.cursor, http2);
    expect(again.items).toEqual([]);
  });
});

describe("fetch: long sections and long changelogs", () => {
  const LONG = "https://example.com/guide";
  const article = (n: string) => `<li>Article about the topic ${n} for the builders and the operators of the platform service</li>`;
  const names = Array.from({ length: 70 }, (_, n) => `alpha${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`);
  const guide = (extra: string[]) =>
    `<main><h1>Guide</h1><h2>New articles</h2><ul>${[...names, ...extra].map(article).join("")}</ul><h2>Other</h2><p>Short text of the other section.</p></main>`;
  const NEW_LINE = "Article about the topic agentmemory for the builders and the operators of the platform service";

  it("a new line after character 4000 of a long section is one item with only the new line (ignoreMinorEdits on)", async () => {
    const { first, second } = await change(LONG, guide([]), guide(["agentmemory"]));
    const long = first.cursor!.sections.find((s) => s.path.endsWith("New articles"))!;
    expect(long.text.length).toBeLessThanOrEqual(4000);
    expect(long.lineKeys!.length).toBeGreaterThan(60);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.text).toBe(NEW_LINE);
    checkItems(second.items);
    // The next poll of the same page gives no item.
    const site = pages(LONG);
    site.serve(guide(["agentmemory"]));
    expect((await poll(cfg(LONG), second.cursor, site.http)).items).toEqual([]);
  });

  it("ignoreMinorEdits off: the item of a long section holds only the new line", async () => {
    const { second } = await change(LONG, guide([]), guide(["agentmemory"]), { ignoreMinorEdits: false });
    expect(second.items.map((i) => i.text)).toEqual([NEW_LINE]);
  });

  it("an old snapshot with no lineKeys still gives the item", async () => {
    const site = pages(LONG);
    site.serve(guide([]));
    const base = await poll(cfg(LONG), null, site.http);
    const old: DocsCursor = {
      ...base.cursor!,
      sections: base.cursor!.sections.map((s) => ({ path: s.path, hash: s.hash, text: s.text })),
    };
    site.serve(guide(["agentmemory"]));
    const next = await poll(cfg(LONG), old, site.http);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.text).toContain(NEW_LINE);
  });

  it("a changelog entry of more than 4000 characters with a new line at the end: one item with the new line", async () => {
    const CHANGES = "https://example.com/release-notes";
    const notes = (extra: string[]) =>
      `<main><h1>Release notes</h1><h2>2026-11-19</h2><h3>Platform release</h3><ul>${[...names, ...extra].map(article).join("")}</ul>` +
      `<h2>2026-11-18</h2><h3>Small fix</h3><p>A small fix of the upload page for the builders.</p>` +
      `<h2>2026-11-17</h2><h3>Other fix</h3><p>A small fix of the search page for the operators.</p></main>`;
    const { first, second } = await change(CHANGES, notes([]), notes(["agentmemory"]));
    expect(first.cursor?.mode).toBe("changelog");
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.meta).toMatchObject({ change: "changed_entry" });
    const lines = second.items[0]!.text.split("\n");
    expect(lines[lines.length - 1]).toContain(NEW_LINE);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("a changelog with more than 500 entries: the same page again gives no item; a new entry gives one", async () => {
    const BIG = "https://example.com/big-changes";
    const html = (top: string) => {
      const items = Array.from({ length: 620 }, (_, n) => `<li>Change number ${n} of the service: short note</li>`).join("");
      return `<main><h1>Changes</h1><h2>2026-11-19</h2><ul>${top}${items}</ul><h2>2026-11-18</h2><p>One</p><h2>2026-11-17</h2><p>Two</p></main>`;
    };
    const site = pages(BIG);
    site.serve(html(""));
    const base = await poll(cfg(BIG), null, site.http);
    expect(base.cursor?.seenEntryIds).toHaveLength(500);
    const again = await poll(cfg(BIG), base.cursor, site.http);
    expect(again.items).toEqual([]);
    const third = await poll(cfg(BIG), again.cursor, site.http);
    expect(third.items).toEqual([]);
    site.serve(html("<li>A brand new change of the service: agent memory</li>"));
    const fresh = await poll(cfg(BIG), third.cursor, site.http);
    expect(fresh.items.map((i) => i.title)).toEqual(["2026-11-19: A brand new change of the service: agent memory"]);
  });
});

describe("fetch: errors and odd input", () => {
  const run = (reply: Parameters<FakeHttp["on"]>[1], config = cfg(FOUNDRY)) =>
    poll(config, null, new FakeHttp().on(FOUNDRY, reply));

  it("status codes", async () => {
    await expectConnectorError(run({ status: 404, text: "" }), "not_found", /^The page address returned 404\.$/);
    await expectConnectorError(run({ status: 410, text: "" }), "not_found");
    await expectConnectorError(run({ status: 403, text: "" }), "blocked", /refused the request \(403\)/);
    await expectConnectorError(run({ status: 429, text: "" }), "rate_limited");
    await expectConnectorError(run({ status: 503, text: "" }), "bad_response", /status 503/);
  });

  it("transport errors", async () => {
    await expectConnectorError(run({ error: new HttpError("timeout", "t") }), "network", /did not answer in time/);
    await expectConnectorError(run({ error: new HttpError("network", "x") }), "network");
    await expectConnectorError(run({ error: new HttpError("blocked_address", "x") }), "blocked");
    await expectConnectorError(run({ error: new HttpError("too_large", "x") }), "bad_response", /too large/);
  });

  it("a feed, an empty page, and a selector that matches nothing", async () => {
    await expectConnectorError(
      run({ text: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>' }),
      "bad_response",
      /feed, not a page/,
    );
    await expectConnectorError(run({ text: "<html><body><script>x()</script></body></html>" }), "bad_response", /no readable text/);
    await expectConnectorError(run({ text: foundry }, cfg(FOUNDRY, { selector: "#nothing-here" })), "bad_response", /"#nothing-here" matches no text/);
  });

  it("a cursor from a broken state (no sections) gives new sections, not a crash", async () => {
    const http = new FakeHttp().on(FOUNDRY, { text: foundry });
    const result = await poll(cfg(FOUNDRY), { mode: "page", sections: [], seenEntryIds: [] }, http);
    expect(result.items.map((i) => i.title)).toEqual([
      "New section: What's new in Microsoft Foundry?",
      "New section: What's new in Microsoft Foundry? > New articles",
      "New section: What's new in Microsoft Foundry? > Updated articles",
    ]);
  });
});
