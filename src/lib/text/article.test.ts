import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractArticle, splitSections } from "./index";

const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

const FOUNDRY_URL = "https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry";
const CURSOR_URL = "https://cursor.com/changelog";

describe("extractArticle", () => {
  it("reads the Foundry page: a page of link lists that Readability does not take", () => {
    const { title, text } = extractArticle(fixture("foundry-whats-new.html"), FOUNDRY_URL);
    expect(title).toContain("What's new for August 2026");
    expect(text.startsWith("Welcome! This article highlights key updates for Microsoft Foundry in August 2026.")).toBe(true);
    expect(text).toContain("New articles\n\n- Foundry Agent Service\n  - Agent optimizer cost and token usage overview");
    expect(text).toContain("Updated articles");
    expect(text).toContain("For more product information about Microsoft Foundry, see the Microsoft Foundry Blog.");
    for (const chrome of ["Was this page helpful", "Table of contents", "Ask Learn", "In this article", "Last updated on", "AI Disclaimer"]) {
      expect(text).not.toContain(chrome);
    }
  });

  it("reads the Cursor changelog with all its entries", () => {
    const { title, text } = extractArticle(fixture("cursor-changelog.html"), CURSOR_URL);
    expect(title).toBe("What's New in Cursor — Latest Updates & Release Notes");
    for (const heading of ["Voice Chat with Agents", "Build Live Apps in Cursor", "Agent SDK", "Origin App Marketplace"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("You can now talk with your agents in a realtime voice call.");
    expect(text).not.toContain("Terms");
    expect(text).not.toMatch(/^#/m);
  });

  it("takes the main content of an article page and leaves the navigation out", () => {
    const paragraph = (n: number): string =>
      `<p>Paragraph ${n} of the article explains in full sentences how the team moved its agents to production, ` +
      "what failed on the way, and which measurements showed that the change was worth the effort for everybody.</p>";
    const html =
      "<html><head><title>How we shipped agents | Example Blog</title></head><body>" +
      '<nav><a href="/">Home</a> <a href="/about">About us</a></nav>' +
      `<article><h1>How we shipped agents</h1>${[1, 2, 3, 4, 5, 6].map(paragraph).join("")}</article>` +
      '<footer>Copyright Example Corp. <a href="/privacy">Privacy policy</a></footer></body></html>';
    const { title, text } = extractArticle(html, "https://blog.example.com/agents");
    expect(title).toContain("How we shipped agents");
    expect(text).toContain("Paragraph 1 of the article");
    expect(text).toContain("Paragraph 6 of the article");
    expect(text).not.toContain("About us");
    expect(text).not.toContain("Privacy policy");
  });

  it("falls back to <main>, then <article>, then <body>", () => {
    const list = "<ul><li><a href='/a'>Alpha release</a></li><li><a href='/b'>Beta release</a></li></ul>";
    expect(extractArticle(`<html><body><nav>Menu</nav><main>${list}</main><footer>Legal</footer></body></html>`, "https://e.example").text).toBe(
      "- Alpha release\n- Beta release",
    );
    expect(extractArticle(`<html><body><nav>Menu</nav><article>${list}</article></body></html>`, "https://e.example").text).toBe(
      "- Alpha release\n- Beta release",
    );
    expect(extractArticle("<html><body><div>short text</div></body></html>", "https://e.example").text).toBe("short text");
  });

  it("finds a title in the page, and uses the address when the page has none", () => {
    expect(extractArticle("<html><head><title>  Page   title </title></head><body><p>x</p></body></html>", "https://e.example/a").title).toBe(
      "Page title",
    );
    expect(extractArticle("<p>fragment with no title</p>", "https://example.com/a/b").title).toBe("example.com/a/b");
    expect(extractArticle("<p>fragment</p>", "not a url").title).toBe("");
  });

  it("returns empty values for empty input", () => {
    expect(extractArticle("", "https://e.example")).toEqual({ title: "", text: "" });
    expect(extractArticle("   ", "https://e.example")).toEqual({ title: "", text: "" });
  });

  it("removes invisible characters from the text", () => {
    const { text } = extractArticle("<html><body><main><p>zero​width and soft­hyphen</p></main></body></html>", "https://e.example");
    expect(text).toBe("zerowidth and softhyphen");
  });
});

describe("splitSections", () => {
  it("finds the heading structure of the Foundry page", () => {
    const sections = splitSections(fixture("foundry-whats-new.html"));
    expect(sections.map((s) => s.path)).toEqual([
      "What's new in Microsoft Foundry?",
      "What's new in Microsoft Foundry? > New articles",
      "What's new in Microsoft Foundry? > Updated articles",
    ]);
    expect(sections.map((s) => s.level)).toEqual([1, 2, 2]);
    expect(sections[0]?.text).toBe("Welcome! This article highlights key updates for Microsoft Foundry in August 2026.");
    const added = sections[1];
    expect(added?.blocks.length).toBeGreaterThanOrEqual(3);
    // One block for each product area: the top-level list item with its nested items.
    expect(added?.blocks[0]?.startsWith("Foundry Agent Service\n  - Agent optimizer cost and token usage overview\n  - ")).toBe(true);
    expect(added?.text.startsWith("- Foundry Agent Service\n  - Agent optimizer cost and token usage overview\n")).toBe(true);
    expect(sections[2]?.blocks.at(-1)).toBe("For more product information about Microsoft Foundry, see the Microsoft Foundry Blog.");
    for (const s of sections) expect(s.text).not.toMatch(/Was this page helpful|Last updated on|Ask Learn/);
  });

  it("finds the entries of the Cursor changelog with their dates", () => {
    const sections = splitSections(fixture("cursor-changelog.html"));
    const paths = sections.map((s) => s.path);
    expect(paths).toContain("Voice Chat with Agents");
    expect(paths).toContain("Voice Chat with Agents > Start a call");
    expect(paths).toContain("Origin App Marketplace > Publish to Marketplace");
    expect(paths.every((p) => !p.includes("#"))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);

    const entries = sections.filter((s) => s.level === 1);
    expect(entries.map((s) => s.path)).toEqual([
      "Voice Chat with Agents",
      "Build Live Apps in Cursor",
      "Agent SDK",
      "Cloud Agent Canvases and Environment Improvements",
      "Origin App Marketplace",
    ]);
    // The date line stands before the heading in the page; it belongs to the entry.
    expect(entries.map((s) => s.datetime)).toEqual([
      "2026-11-06T00:00:00.000Z",
      "2026-11-05T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
      "2026-10-13T00:00:00.000Z",
    ]);
    expect(entries[0]?.text.startsWith("Nov 6, 2026")).toBe(true);
    expect(entries[0]?.blocks[1]).toBe(
      "You can now talk with your agents in a realtime voice call. Describe a change out loud, ask what an agent is working on, and hear updates as the work moves forward.",
    );
    const last = sections.at(-1);
    expect(last?.path).toBe("Origin App Marketplace > Get started");
    expect(last?.text).not.toContain("Nov 6, 2026");
  });

  it("uses the selector when one is given", () => {
    const html = fixture("cursor-changelog.html");
    const first = splitSections(html, "article");
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((s) => s.path.startsWith("Voice Chat with Agents"))).toBe(true);
    expect(splitSections(html, ".no-such-class")).toEqual([]);
    expect(splitSections(html, "][ not a selector")).toEqual([]);
  });

  it("builds paths from nested headings and drops empty sections", () => {
    const html =
      "<main><p>Lead text.</p><h1>Top</h1><p>A</p><h2>Sub one</h2><p>B</p><ul><li>x</li><li>y<ul><li>y1</li></ul></li></ul>" +
      "<h3>Deep</h3><p>C</p><h2>Sub two</h2><p>D</p><h2>Empty</h2><h2>Sub two</h2><p>E</p><h5>Minor</h5><p>F</p>" +
      "<h1>Second top</h1><p>G</p></main>";
    const sections = splitSections(html);
    expect(sections.map((s) => [s.path, s.level, s.text])).toEqual([
      ["(intro)", 0, "Lead text."],
      ["Top", 1, "A"],
      ["Top > Sub one", 2, "B\n\n- x\n- y\n  - y1"],
      ["Top > Sub one > Deep", 3, "C"],
      ["Top > Sub two", 2, "D"],
      ["Top > Sub two (2)", 2, "E\n\nMinor\n\nF"],
      ["Second top", 1, "G"],
    ]);
    expect(sections[2]?.blocks).toEqual(["B", "x", "y\n  - y1"]);
    expect(sections[5]?.blocks).toEqual(["E", "Minor", "F"]);
  });

  it("removes controls, navigation, and permalink marks from the content", () => {
    const html =
      '<main><nav><h2>On this page</h2><a href="#a">A</a></nav><h1>Guide<a class="headerlink" href="#guide">¶</a></h1>' +
      '<button>Copy</button><p>Body text.</p><h2><a href="#setup">#</a>Setup</h2><p>Steps.</p>' +
      '<div hidden><h2>Hidden heading</h2><p>Hidden text.</p></div><footer><p>Edit this page</p></footer></main>';
    expect(splitSections(html).map((s) => [s.path, s.text])).toEqual([
      ["Guide", "Body text."],
      ["Guide > Setup", "Steps."],
    ]);
  });

  it("removes feedback furniture and keeps a content section with the same word as its id", () => {
    const body = "<p>" + "The API returns a page of results and a cursor for the next page. ".repeat(12) + "</p>";
    const html =
      `<main><h1>Docs</h1>${body}<section id="cookies"><h2>Cookies</h2><p>How the API sets cookies.</p></section>` +
      '<div class="feedback-widget"><h2>Feedback</h2><p>Was this helpful?</p></div>' +
      '<div id="page-footer-meta"><p>Last updated on 2026-10-30</p></div></main>';
    const sections = splitSections(html);
    expect(sections.map((s) => s.path)).toEqual(["Docs", "Docs > Cookies"]);
    expect(sections[1]?.text).toBe("How the API sets cookies.");
  });

  it("gives the date line of an <article> to the heading of that article", () => {
    const html =
      "<main>" +
      '<article><p><time datetime="2026-03-02">March 2, 2026</time></p><h2>Second release</h2><p>Notes two.</p></article>' +
      '<article><p><time datetime="2026-03-01">March 1, 2026</time></p><h2>First release</h2><p>Notes one.</p></article>' +
      "</main>";
    expect(splitSections(html)).toEqual([
      { path: "Second release", level: 2, text: "March 2, 2026\n\nNotes two.", blocks: ["March 2, 2026", "Notes two."], datetime: "2026-03-02" },
      { path: "First release", level: 2, text: "March 1, 2026\n\nNotes one.", blocks: ["March 1, 2026", "Notes one."], datetime: "2026-03-01" },
    ]);
  });

  it("keeps a long text before the first heading of an <article> where it is", () => {
    const long = "This long introduction is the body of the article, and it does not belong to the next heading. ".repeat(4).trim();
    const html = `<main><h1>Post</h1><article><p>${long}</p><h2>Details</h2><p>d</p></article></main>`;
    expect(splitSections(html).map((s) => [s.path, s.text])).toEqual([
      ["Post", long],
      ["Post > Details", "d"],
    ]);
  });

  it("uses the <article> elements or the body when the page has no <main>", () => {
    const html = "<html><body><article><h2>One</h2><p>1</p></article><article><h2>Two</h2><p>2</p></article></body></html>";
    expect(splitSections(html).map((s) => [s.path, s.text])).toEqual([
      ["One", "1"],
      ["Two", "2"],
    ]);
    expect(splitSections("<h2>Only</h2><p>fragment</p>").map((s) => [s.path, s.text])).toEqual([["Only", "fragment"]]);
    expect(splitSections("<p>no heading at all</p>")).toEqual([{ path: "(intro)", level: 0, text: "no heading at all", blocks: ["no heading at all"] }]);
  });

  it("returns an empty list for empty input", () => {
    expect(splitSections("")).toEqual([]);
    expect(splitSections("<main></main>")).toEqual([]);
  });
});
