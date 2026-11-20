import { describe, expect, it } from "vitest";

import { canonicalizeUrl, extractLinks, isRootUrl } from "./index";

describe("canonicalizeUrl", () => {
  it("makes the scheme and the host lower case and removes default ports", () => {
    expect(canonicalizeUrl("HTTP://Example.COM:80/Path")).toBe("http://example.com/Path");
    expect(canonicalizeUrl("https://example.com:443")).toBe("https://example.com/");
    expect(canonicalizeUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
  });

  it("does not change the scheme", () => {
    expect(canonicalizeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(canonicalizeUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("removes the fragment", () => {
    expect(canonicalizeUrl("https://example.com/a#section-2")).toBe("https://example.com/a");
  });

  it("removes the listed tracking parameters and keeps the others in their order", () => {
    expect(canonicalizeUrl("https://example.com/Path/?utm_source=x&b=2&a=1&fbclid=abc#frag")).toBe(
      "https://example.com/Path?b=2&a=1",
    );
    expect(
      canonicalizeUrl(
        "https://example.com/a?gclid=1&dclid=2&msclkid=3&mc_cid=4&mc_eid=5&igshid=6&ref=hn&ref_src=tw&REF_URL=x&Utm_Campaign=y&id=7",
      ),
    ).toBe("https://example.com/a?id=7");
  });

  it('keeps "source" and names that only look like tracking names', () => {
    expect(canonicalizeUrl("https://example.com/a?source=rss&reference=1&utm=2&refs=3&referrer=4")).toBe(
      "https://example.com/a?source=rss&reference=1&utm=2&refs=3&referrer=4",
    );
  });

  it("keeps the encoding of the parameters that stay", () => {
    expect(canonicalizeUrl("https://example.com/s?q=a%20b&x=1+2&utm_term=z")).toBe("https://example.com/s?q=a%20b&x=1+2");
  });

  it("removes an empty query", () => {
    expect(canonicalizeUrl("https://example.com/a?")).toBe("https://example.com/a");
    expect(canonicalizeUrl("https://example.com/a?&&x=1&")).toBe("https://example.com/a?x=1");
    expect(canonicalizeUrl("https://example.com/?utm_medium=email")).toBe("https://example.com/");
  });

  it('removes the "/" at the end of the path and keeps the root path', () => {
    expect(canonicalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
    expect(canonicalizeUrl("https://example.com/a/b///?x=1")).toBe("https://example.com/a/b?x=1");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("returns an input that is not an http(s) URL trimmed and unchanged", () => {
    expect(canonicalizeUrl("  mailto:a@b.example ")).toBe("mailto:a@b.example");
    expect(canonicalizeUrl("ftp://example.com/dir/")).toBe("ftp://example.com/dir/");
    expect(canonicalizeUrl(" not a url ")).toBe("not a url");
    expect(canonicalizeUrl("www.example.com/a/")).toBe("www.example.com/a/");
    expect(canonicalizeUrl("https://")).toBe("https://");
    expect(canonicalizeUrl("")).toBe("");
    expect(canonicalizeUrl(undefined as unknown as string)).toBe("");
  });

  it("gives the same result when it runs again", () => {
    for (const url of [
      "HTTP://Example.COM:80/Path/?utm_source=x&b=2&a=1#frag",
      "https://example.com/wiki/Foo_(bar)?q=%E2%9C%93&ref=x",
      "https://user:pw@example.com/a/",
      "https://例え.jp/パス/",
    ]) {
      const once = canonicalizeUrl(url);
      expect(canonicalizeUrl(once)).toBe(once);
    }
  });
});

describe("isRootUrl", () => {
  it("is true for a root path with no query", () => {
    expect(isRootUrl("https://example.com")).toBe(true);
    expect(isRootUrl("https://example.com/")).toBe(true);
    expect(isRootUrl("https://example.com/#top")).toBe(true);
    expect(isRootUrl("https://example.com/?utm_source=x")).toBe(true);
  });

  it("is false for a path, a query, or an input that is not an http(s) URL", () => {
    expect(isRootUrl("https://example.com/a")).toBe(false);
    expect(isRootUrl("https://example.com/?q=1")).toBe(false);
    expect(isRootUrl("mailto:a@b.example")).toBe(false);
    expect(isRootUrl("")).toBe(false);
    expect(isRootUrl("example.com")).toBe(false);
  });
});

describe("extractLinks", () => {
  it("returns the href values and the URLs in the text, in document order, canonical", () => {
    const html =
      '<p>See <a href="https://example.com/a?utm_source=x">A</a> and <a class="l" href=\'/rel/path/\'>rel</a>, ' +
      'plain https://plain.example.org/x. Also <a href="mailto:x@y.example">mail</a> <a href="#top">top</a> ' +
      '<a href="javascript:void(0)">js</a> <a href="https://example.com/a">dup</a> ' +
      '<img src="https://img.example.com/p.gif"><a href="HTTPS://Last.example.com/z/#f">last</a></p>';
    expect(extractLinks(html, "https://base.example.com/dir/page")).toEqual([
      "https://example.com/a",
      "https://base.example.com/rel/path",
      "https://plain.example.org/x",
      "https://last.example.com/z",
    ]);
  });

  it("skips relative links when there is no base URL", () => {
    expect(extractLinks('<a href="/rel">r</a> <a href="//cdn.example.com/x">p</a> <a href="https://a.example.com/">a</a>')).toEqual([
      "https://a.example.com/",
    ]);
  });

  it("finds URLs in plain text and removes punctuation at their end", () => {
    const text =
      "Read https://a.example.com/x, then (https://b.example.com/y) and https://en.wikipedia.org/wiki/Foo_(bar). " +
      'Quoted "https://c.example.com/z?q=1!" and http://d.example.com/path/; ftp://no.example.com/x is ignored.';
    expect(extractLinks(text)).toEqual([
      "https://a.example.com/x",
      "https://b.example.com/y",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://c.example.com/z?q=1",
      "http://d.example.com/path",
    ]);
  });

  it("decodes character references in addresses", () => {
    expect(extractLinks('<a href="https://e.example.com/?a=1&amp;b=2">x</a> and https://f.example.com/?c=3&amp;d=4&nbsp;end')).toEqual([
      "https://e.example.com/?a=1&b=2",
      "https://f.example.com/?c=3&d=4",
    ]);
  });

  it("ignores addresses in scripts, styles, comments, and other attributes", () => {
    const html =
      '<script>var u = "https://s.example.com/";</script><style>a{background:url(https://css.example.com/i.png)}</style>' +
      '<!-- https://comment.example.com/ --><link rel="stylesheet" href="https://l.example.com/a.css">' +
      '<div data-url="https://attr.example.com/">text</div>';
    expect(extractLinks(html)).toEqual([]);
  });

  it("returns no duplicates and at most 50 links", () => {
    const many = Array.from({ length: 60 }, (_, i) => `<a href="https://example.com/p/${i}">p</a> https://example.com/p/${i}/`).join(" ");
    const links = extractLinks(many);
    expect(links).toHaveLength(50);
    expect(new Set(links).size).toBe(50);
    expect(links[0]).toBe("https://example.com/p/0");
    expect(links[49]).toBe("https://example.com/p/49");
  });

  it("returns an empty list for empty input", () => {
    expect(extractLinks("")).toEqual([]);
    expect(extractLinks("no links here")).toEqual([]);
    expect(extractLinks(undefined as unknown as string)).toEqual([]);
  });
});
