import { describe, expect, it } from "vitest";

import { decodeEntities, htmlToText } from "./index";

describe("htmlToText", () => {
  it("puts paragraphs and headings in separate blocks", () => {
    expect(htmlToText("<h1>Title</h1><p>First para.</p><p>Second <b>bold</b> para.</p>")).toBe(
      "Title\n\nFirst para.\n\nSecond bold para.",
    );
    expect(htmlToText("<div>a</div><div>b</div>")).toBe("a\n\nb");
    expect(htmlToText("<P>Upper</P><BLOCKQUOTE>Quote</BLOCKQUOTE>")).toBe("Upper\n\nQuote");
  });

  it('starts list items with "- "', () => {
    expect(htmlToText("<p>Intro</p><ul><li>one</li><li>two</li></ul><p>After</p>")).toBe(
      "Intro\n\n- one\n- two\n\nAfter",
    );
    expect(htmlToText("<ol><li>first</li><li>second</li></ol>")).toBe("- first\n- second");
  });

  it("keeps nested lists below their item", () => {
    expect(htmlToText("<ul><li>one</li><li>two<ul><li>nested a</li><li>nested b</li></ul></li><li>three</li></ul>")).toBe(
      "- one\n- two\n  - nested a\n  - nested b\n- three",
    );
  });

  it("keeps the items of a list with paragraphs on adjacent lines", () => {
    expect(htmlToText("<ul><li><p>one</p></li><li><p>two</p><p>more</p></li></ul>")).toBe("- one\n- two\nmore");
    // Close tags of list items are optional in HTML.
    expect(htmlToText("<ul><li>one<li>two</ul>")).toBe("- one\n- two");
  });

  it("keeps line breaks", () => {
    expect(htmlToText("<p>a<br>b<br/>c<BR>d</p>")).toBe("a\nb\nc\nd");
    expect(htmlToText("<p>a<br><br>b</p>")).toBe("a\n\nb");
  });

  it("keeps the link text and drops the address", () => {
    expect(htmlToText('<p>See <a href="https://x.test/p?utm_source=n">the release notes</a>.</p>')).toBe(
      "See the release notes.",
    );
  });

  it("drops scripts, styles, noscript, template, svg, and images", () => {
    const html =
      '<script>var x = "<p>no</p>";</script><style>p { color: red }</style><noscript>ns</noscript>' +
      "<template><p>t</p></template><svg><text>s</text><svg><text>inner</text></svg></svg>" +
      '<img src="https://t.example.com/pixel.gif" alt="alt text" width="1" height="1">ok';
    expect(htmlToText(html)).toBe("ok");
  });

  it("drops the head of a document", () => {
    expect(
      htmlToText("<!DOCTYPE html><html><head><title>T</title><style>x{}</style></head><body><p>Body</p></body></html>"),
    ).toBe("Body");
  });

  it("drops comments and form state", () => {
    expect(htmlToText("a<!-- hidden <p>x</p> -->b")).toBe("ab");
    expect(htmlToText("<p>Pick</p><select><option>One</option></select><textarea>draft</textarea><p>Done</p>")).toBe(
      "Pick\n\nDone",
    );
  });

  it("drops hidden elements", () => {
    const html =
      '<p>shown</p><div hidden>secret</div><span aria-hidden="true">#</span>' +
      '<div style="color:red; display: none">pre<div>nested</div>header</div><p>end</p>';
    expect(htmlToText(html)).toBe("shown\n\nend");
    // The class name "hidden" is not the attribute.
    expect(htmlToText('<div class="hidden xl:grid">visible</div>')).toBe("visible");
    // A hidden <body> is a page that a script shows later.
    expect(htmlToText('<html><body style="visibility:hidden"><p>text</p></body></html>')).toBe("text");
  });

  it("decodes character references", () => {
    expect(htmlToText("<p>&amp; &lt;tag&gt; &nbsp;&copy; &#8217; &#x2014; &rsquo; &unknown;</p>")).toBe(
      "& <tag> © ’ — ’ &unknown;",
    );
  });

  it("collapses runs of spaces and has at most one empty line in sequence", () => {
    expect(htmlToText("<p>a   b\t\tc\n   d</p>")).toBe("a b c d");
    expect(htmlToText("<p>a</p><p></p><p>&nbsp;</p><div><br><br><br></div>\n\n\n<p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>a<br><br><br><br>b</p>")).not.toMatch(/\n{3}/);
  });

  it("puts the cells of a table row on one line", () => {
    expect(
      htmlToText("<table><tr><th>Model</th><th>Price</th></tr><tr><td>A</td><td>$1</td></tr></table>"),
    ).toBe("Model Price\nA $1");
  });

  it("keeps the lines of preformatted text", () => {
    expect(htmlToText("<p>Run:</p><pre>line 1\n  indented\n\n\nline 4\n</pre>")).toBe(
      "Run:\n\nline 1\n  indented\n\nline 4",
    );
  });

  it("reads definition lists as lines", () => {
    expect(htmlToText("<dl><dt>Term</dt><dd>Definition</dd></dl>")).toBe("Term\nDefinition");
  });

  it("gives plain text back with the same lines", () => {
    expect(htmlToText("Line one\nLine two\n\n\n\nLine  three   spaced \n- item")).toBe(
      "Line one\nLine two\n\nLine three spaced\n- item",
    );
    expect(htmlToText("a < b and 3 > 2, also x <3 y")).toBe("a < b and 3 > 2, also x <3 y");
    expect(htmlToText("Tom &amp; Jerry at AT&T")).toBe("Tom & Jerry at AT&T");
    expect(htmlToText("Windows\r\nline\rold mac")).toBe("Windows\nline\nold mac");
  });

  it("keeps the lines of text that has only inline tags", () => {
    expect(htmlToText('Line one\nLine <b>two</b> with <a href="https://x.test">a link</a>\n\nThree')).toBe(
      "Line one\nLine two with a link\n\nThree",
    );
  });

  it("does not fail on broken markup", () => {
    expect(htmlToText("<p>unclosed <b>bold<p>next")).toBe("unclosed bold\n\nnext");
    expect(htmlToText("<p>text <")).toBe("text <");
    expect(htmlToText("a <b")).toBe("a <b");
    expect(htmlToText("<div")).toBe("<div");
    expect(htmlToText("</p></div>stray close")).toBe("stray close");
    expect(htmlToText('<p title="a > b">quoted</p>')).toBe("quoted");
    expect(htmlToText("<p>before</p><script>never closed")).toBe("before");
    expect(htmlToText("<h2>Heading with no close<p>Body</p>")).toContain("Body");
  });

  it("gives an empty text for an empty or wrong input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("   \n  ")).toBe("");
    expect(htmlToText(undefined as unknown as string)).toBe("");
    expect(htmlToText("<p></p><img src='x.png'>")).toBe("");
  });

  it("keeps text in other scripts and emoji", () => {
    expect(htmlToText("<p>東京 — Москва 🚀</p>")).toBe("東京 — Москва 🚀");
  });

  it("converts a 3 MB document in less than 2 seconds", () => {
    const unit =
      '<div class="entry"><h2 id="t">Release title</h2><p>Some <a href="https://example.com/a?b=1&amp;c=2">linked</a> ' +
      "text &amp; more words to fill the paragraph with content.</p><ul><li>one</li><li>two</li></ul>" +
      '<script>track("x")</script><img src="p.gif"></div>\n';
    const count = Math.ceil(3_000_000 / unit.length);
    const html = unit.repeat(count);
    expect(html.length).toBeGreaterThanOrEqual(3_000_000);
    const started = performance.now();
    const text = htmlToText(html);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(text.split("Release title").length - 1).toBe(count);
    expect(text).not.toContain("track(");
    expect(text.startsWith("Release title\n\nSome linked text & more words")).toBe(true);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric references one time", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&lt;p&gt; &quot;q&quot; &apos;a&apos;")).toBe("<p> \"q\" 'a'");
    expect(decodeEntities("&eacute;&yuml;&times;&divide;&Omega;&sigmaf;&omega;&hellip;&euro;&mdash;")).toBe("éÿ×÷Ωςω…€—");
    expect(decodeEntities("&#65;&#x42;&#X43;&#x1F600;")).toBe("ABC😀");
  });

  it("reads the numbers 128 to 159 as Windows-1252", () => {
    expect(decodeEntities("&#128;&#146;&#151;")).toBe("€’—");
  });

  it("replaces numbers that are not characters", () => {
    expect(decodeEntities("&#0;&#xD800;&#9999999;")).toBe("���");
  });

  it("leaves unknown references and bare ampersands", () => {
    expect(decodeEntities("AT&T &notanentity; &amp &#99999999; &;")).toBe("AT&T &notanentity; &amp &#99999999; &;");
  });
});
