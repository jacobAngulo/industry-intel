import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverFeeds, NOT_A_FEED_MESSAGE, NotAFeedError, parseDate, parseDuration, parseFeed } from "./index";

const fixture = (name: string): string => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

describe("parseFeed with recorded feeds", () => {
  it("reads an RSS 2.0 blog feed (Microsoft Foundry blog)", () => {
    const feed = parseFeed(fixture("rss-foundry-blog.xml"));
    expect(feed.title).toBe("Microsoft Foundry Blog");
    expect(feed.siteUrl).toBe("https://devblogs.microsoft.com/foundry/");
    expect(feed.entries.map((e) => e.id)).toEqual([
      "https://devblogs.microsoft.com/foundry/?p=3401",
      "https://devblogs.microsoft.com/foundry/?p=3365",
      "https://devblogs.microsoft.com/foundry/?p=3334",
    ]);
    const [first, second, third] = feed.entries;
    expect(first?.title).toBe("Build trusted autonomous agents for your team with Microsoft Foundry");
    expect(first?.link).toBe(
      "https://devblogs.microsoft.com/foundry/build-trusted-autonomous-agents-for-your-team-with-microsoft-foundry/",
    );
    expect(first?.author).toBe("Amanda Foster");
    expect(first?.publishedAt).toBe(Date.UTC(2026, 10, 19, 19, 53, 30));
    expect(first?.categories).toEqual(["Microsoft Foundry"]);
    // content:encoded is fuller than the description.
    expect(first?.html?.length).toBeGreaterThan(3000);
    expect(first?.text.startsWith("A new kind of agent can work alongside your team in Microsoft 365")).toBe(true);
    expect(first?.text).not.toMatch(/<\/?[a-z]+[^>]*>/);
    expect(first?.text).not.toContain("appeared first on");
    expect(second?.author).toBe("Muzz Imam, Eamon O'Reilly");
    expect(second?.categories).toContain("Hosted Agents");
    expect(third?.title).toBe("Browser Automation Tool in Microsoft Foundry : Ignite’26 Announcements");
    expect(third?.enclosure).toEqual({
      url: "https://devblogs.microsoft.com/foundry/wp-content/uploads/sites/89/2026/11/BAT_Ignite-demo_Final.mp4",
      type: "video/mp4",
      length: 20762991,
    });
    expect(first?.enclosure).toBeUndefined();
  });

  it("reads a GitHub releases Atom feed", () => {
    const feed = parseFeed(fixture("atom-github-releases.xml"));
    expect(feed.title).toBe("Release notes from claude-code");
    expect(feed.siteUrl).toBe("https://github.com/anthropics/claude-code/releases");
    expect(feed.entries.map((e) => e.title)).toEqual(["v2.1.329", "v2.1.328", "v2.1.327"]);
    const first = feed.entries[0];
    expect(first?.id).toBe("tag:github.com,2008:Repository/937253475/v2.1.329");
    expect(first?.link).toBe("https://github.com/anthropics/claude-code/releases/tag/v2.1.329");
    expect(first?.author).toBe("claude-code-publisher[bot]");
    expect(first?.publishedAt).toBe(Date.parse("2026-11-19T22:14:41Z"));
    expect(first?.extra["updatedAt"]).toBe(Date.parse("2026-11-19T22:14:41Z"));
    expect(first?.html?.startsWith("<h2>What's changed</h2>")).toBe(true);
    expect(first?.text.startsWith("What's changed\n\n- Added a trust dialog warning that says where a folder's hooks are declared\n- ")).toBe(true);
    expect(first?.extra["media:thumbnail"]).toEqual({
      height: "30",
      width: "30",
      url: "https://avatars.githubusercontent.com/u/76263028?s=60&v=4",
    });
    expect(first?.categories).toEqual([]);
    expect(first?.enclosure).toBeUndefined();
  });

  it("reads a YouTube channel feed", () => {
    const feed = parseFeed(fixture("atom-youtube-channel.xml"));
    expect(feed.title).toBe("Google for Developers");
    expect(feed.siteUrl).toBe("https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(feed.entries).toHaveLength(4);
    const first = feed.entries[0];
    expect(first?.id).toBe("yt:video:f2bpv9mFUeE");
    expect(first?.title).toBe("Google Antigravity and Gemini 4: Building a custom groovebox on a $40 macro pad");
    expect(first?.link).toBe("https://www.youtube.com/watch?v=f2bpv9mFUeE");
    expect(first?.author).toBe("Google for Developers");
    expect(first?.publishedAt).toBe(Date.parse("2026-11-18T20:00:24+00:00"));
    expect(first?.extra["updatedAt"]).toBe(Date.parse("2026-11-19T08:01:14+00:00"));
    expect(first?.extra["yt:videoId"]).toBe("f2bpv9mFUeE");
    expect(first?.extra["yt:channelId"]).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const group = first?.extra["media:group"] as Record<string, unknown>;
    expect(typeof group["media:description"]).toBe("string");
    expect((group["media:description"] as string).startsWith("Watch music producer, DJ, and pianist")).toBe(true);
    expect(group["media:thumbnail"]).toEqual({ url: "https://i3.ytimg.com/vi/f2bpv9mFUeE/hqdefault.jpg", width: "480", height: "360" });
    // The description is plain text: it is the text of the entry, with its lines, and there is no HTML.
    expect(first?.html).toBeUndefined();
    expect(first?.text.startsWith("Watch music producer, DJ, and pianist Arlander Taylor")).toBe(true);
    expect(first?.text).toContain("\n\n");
    expect(first?.text).toContain("https://goo.gle/3VEGoHz");
  });

  it("reads the All-In podcast feed, which has no transcript element", () => {
    const feed = parseFeed(fixture("podcast-all-in.xml"));
    expect(feed.title).toBe("All-In with Chamath, Jason, Sacks & Friedberg");
    expect(feed.siteUrl).toBe("http://allinchamathjason.libsyn.com/website");
    expect(feed.entries).toHaveLength(3);
    for (const e of feed.entries) {
      expect(e.extra["podcast:transcript"]).toBeUndefined();
      expect(e.enclosure?.type).toBe("audio/mpeg");
      expect(e.publishedAt).toBeTypeOf("number");
      expect(e.author).toBe("All-In Podcast, LLC");
      expect(e.text.length).toBeGreaterThan(500);
    }
    const first = feed.entries[0];
    expect(first?.id).toBe("22b845c5-e5be-4dd1-b4dd-7f3843120d12");
    expect(first?.title).toBe("Databricks CEO: AGI Is Already Here, Why Companies Are Behind, and the Superintelligence Debate");
    expect(first?.link).toBe(
      "https://allinchamathjason.libsyn.com/databricks-ceo-agi-is-already-here-why-companies-are-behind-and-the-superintelligence-debate",
    );
    expect(first?.publishedAt).toBe(Date.UTC(2026, 10, 17, 21, 43, 0));
    expect(first?.enclosure).toEqual({
      url: "https://dts.podtrac.com/redirect.mp3/traffic.libsyn.com/secure/allinchamathjason/AUDIO_99_AliGhodsi_Databricks.mp3?dest-id=1928300",
      type: "audio/mpeg",
      length: 152615419,
    });
    expect(first?.extra["itunes:duration"]).toBe("01:02:06");
    expect(parseDuration(first?.extra["itunes:duration"])).toBe(3726);
    expect(first?.extra["itunes:episodeType"]).toBe("full");
    expect(first?.text.startsWith("(0:00) Ali Ghodsi joins the show: Databricks' early bets on cloud, AI, and open source\n\n(8:50) Is AGI Already Here?")).toBe(true);
  });

  it("reads a podcast feed with podcast:transcript elements (Practical AI)", () => {
    const feed = parseFeed(fixture("podcast-practical-ai.xml"));
    expect(feed.title).toBe("Practical AI");
    expect(feed.siteUrl).toBe("https://practicalai.show/");
    expect(feed.entries).toHaveLength(2);
    const first = feed.entries[0];
    expect(first?.title).toBe("Building Human-Centered AI");
    expect(first?.id).toBe("3cb337f1-41e8-46b6-b2c4-c7b5da3a0944");
    expect(first?.author).toBe("Daniel Whitenack and Chris Benson");
    expect(first?.publishedAt).toBe(Date.parse("2026-11-19T10:00:00Z"));
    expect(first?.extra["podcast:transcript"]).toEqual([
      { url: "https://share.transistor.fm/s/bb4dad17/transcription.vtt", type: "text/vtt", rel: "captions" },
      { url: "https://share.transistor.fm/s/bb4dad17/transcription.srt", type: "application/x-subrip", rel: "captions" },
      { url: "https://share.transistor.fm/s/bb4dad17/transcription.json", type: "application/json", rel: "captions" },
      { url: "https://share.transistor.fm/s/bb4dad17/transcription.txt", type: "text/plain" },
      { url: "https://share.transistor.fm/s/bb4dad17/transcription", type: "text/html" },
    ]);
    expect(first?.extra["itunes:episode"]).toBe("381");
    expect(first?.extra["itunes:duration"]).toBe("2695");
    expect(parseDuration(first?.extra["itunes:duration"])).toBe(2695);
    expect(first?.enclosure?.length).toBe(43164812);
    for (const e of feed.entries) expect(Array.isArray(e.extra["podcast:transcript"])).toBe(true);
  });

  it("reads a JSON Feed", () => {
    const feed = parseFeed(fixture("jsonfeed-org.json"));
    expect(feed.title).toBe("JSON Feed");
    expect(feed.siteUrl).toBe("https://www.jsonfeed.org/");
    expect(feed.entries).toHaveLength(2);
    const first = feed.entries[0];
    expect(first?.id).toBe("http://jsonfeed.micro.blog/2020/08/07/json-feed-version.html");
    expect(first?.title).toBe("JSON Feed version 1.1");
    expect(first?.link).toBe("https://www.jsonfeed.org/2020/08/07/json-feed-version.html");
    expect(first?.publishedAt).toBe(Date.parse("2020-08-07T11:44:36-05:00"));
    expect(first?.html).toContain("&rsquo;");
    expect(first?.text.startsWith("We’ve updated the spec to version 1.1. It’s a minor update to JSON Feed")).toBe(true);
    expect(first?.categories).toEqual([]);
  });
});

describe("parseFeed with small cases", () => {
  const RSS = `﻿  \n<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Tom &amp;amp; Jerry&#8217;s &lt;b&gt;Blog&lt;/b&gt;</title><link>https://blog.example.com/</link>
<item><title><![CDATA[Fish & Chips <em>today</em>]]></title><link>/posts/1</link><guid isPermaLink="false">abc-1</guid>
  <pubDate>Thu, 19 Nov 2026 19:53:30 +0000</pubDate><category><![CDATA[Food & Drink]]></category><category domain="x">food &amp; drink</category>
  <description><![CDATA[<p>Hello <a href="/x">world</a> &amp; all</p><img src="https://t.example.com/pixel.gif" width="1" height="1">]]></description>
  <enclosure url="/media/1.mp3" type="audio/mpeg" length="123"/></item>
<item><title>No date &amp; no guid</title><link>https://blog.example.com/posts/2?a=1&amp;b=2</link><description>Plain &lt;b&gt;escaped&lt;/b&gt; text</description></item>
<item><title>Only a title</title></item>
<item><description>Only a description is here.</description><pubDate>not a date</pubDate></item>
</channel></rss>`;

  it("tolerates a byte order mark, space before the declaration, CDATA, and character references", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe("Tom & Jerry’s Blog");
    expect(feed.siteUrl).toBe("https://blog.example.com/");
    expect(feed.entries).toHaveLength(4);
    const first = feed.entries[0];
    expect(first?.title).toBe("Fish & Chips today");
    expect(first?.id).toBe("abc-1");
    expect(first?.link).toBe("https://blog.example.com/posts/1");
    expect(first?.publishedAt).toBe(Date.UTC(2026, 10, 19, 19, 53, 30));
    expect(first?.html).toBe('<p>Hello <a href="/x">world</a> &amp; all</p><img src="https://t.example.com/pixel.gif" width="1" height="1">');
    expect(first?.text).toBe("Hello world & all");
    expect(first?.categories).toEqual(["Food & Drink"]);
    expect(first?.enclosure).toEqual({ url: "https://blog.example.com/media/1.mp3", type: "audio/mpeg", length: 123 });
  });

  it("uses the link as the id when there is no guid, and leaves the date out when there is none", () => {
    const second = parseFeed(RSS).entries[1];
    expect(second?.id).toBe("https://blog.example.com/posts/2?a=1&b=2");
    expect(second?.link).toBe("https://blog.example.com/posts/2?a=1&b=2");
    expect(second?.title).toBe("No date & no guid");
    expect(second?.html).toBe("Plain <b>escaped</b> text");
    expect(second?.text).toBe("Plain escaped text");
    expect(second && "publishedAt" in second).toBe(false);
  });

  it("uses a stable hash as the id when there is no guid and no link", () => {
    const a = parseFeed(RSS).entries;
    const b = parseFeed(RSS).entries;
    expect(a[2]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a[3]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a[2]?.id).not.toBe(a[3]?.id);
    expect(a[2]?.id).toBe(b[2]?.id);
    expect(a[2]?.title).toBe("Only a title");
    expect(a[2]?.text).toBe("");
    expect(a[2]?.link).toBeUndefined();
    expect(a[2]?.html).toBeUndefined();
    // No title: the first line of the text. No valid date: no date (never the current time).
    expect(a[3]?.title).toBe("Only a description is here.");
    expect(a[3]?.publishedAt).toBeUndefined();
  });

  it("never invents a date", () => {
    const xml = `<rss version="2.0"><channel><title>T</title>
      <item><title>a</title><pubDate></pubDate></item>
      <item><title>b</title><pubDate>0001-01-01T00:00:00Z</pubDate></item>
      <item><title>c</title><pubDate>Soon</pubDate></item>
      <item><title>d</title></item></channel></rss>`;
    const before = Date.now();
    const feed = parseFeed(xml);
    expect(feed.entries.map((e) => e.title)).toEqual(["a", "b", "c", "d"]);
    for (const e of feed.entries) expect(e.publishedAt).toBeUndefined();
    expect(JSON.stringify(feed)).not.toContain(String(before).slice(0, 8));
  });

  it("resolves relative links against the base URL when the feed has no link", () => {
    const xml = `<rss version="2.0"><channel><title>Rel</title>
      <item><title>One</title><link>/a/b</link><enclosure url="m/1.mp3" type="audio/mpeg"/></item></channel></rss>`;
    const withBase = parseFeed(xml, "https://feeds.example.net/dir/feed.xml");
    expect(withBase.siteUrl).toBeUndefined();
    expect(withBase.entries[0]?.link).toBe("https://feeds.example.net/a/b");
    expect(withBase.entries[0]?.id).toBe("https://feeds.example.net/a/b");
    expect(withBase.entries[0]?.enclosure).toEqual({ url: "https://feeds.example.net/dir/m/1.mp3", type: "audio/mpeg" });
    const noBase = parseFeed(xml);
    expect(noBase.entries[0]?.link).toBeUndefined();
    expect(noBase.entries[0]?.enclosure).toBeUndefined();
    expect(noBase.entries[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes a guid that is a permalink as the link", () => {
    const xml = `<rss version="2.0"><channel><title>G</title>
      <item><title>One</title><guid>https://g.example.com/1</guid></item>
      <item><title>Two</title><guid isPermaLink="false">https://g.example.com/2</guid></item></channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.entries[0]?.link).toBe("https://g.example.com/1");
    expect(feed.entries[1]?.link).toBeUndefined();
    expect(feed.entries[1]?.id).toBe("https://g.example.com/2");
  });

  it("reads authors in the RSS forms and does not take a bare address as a name", () => {
    const xml = `<rss version="2.0"><channel><title>A</title>
      <item><title>1</title><author>jane@example.com (Jane Doe)</author></item>
      <item><title>2</title><author>John Roe &lt;john@example.com&gt;</author></item>
      <item><title>3</title><author>only@example.com</author></item>
      <item><title>4</title><author>Plain Name</author></item></channel></rss>`;
    expect(parseFeed(xml).entries.map((e) => e.author)).toEqual(["Jane Doe", "John Roe", undefined, "Plain Name"]);
  });

  it("reads namespaced fields when the feed declares other prefixes", () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:c="http://purl.org/rss/1.0/modules/content/" xmlns:d="http://purl.org/dc/elements/1.1/"
     xmlns:pod="https://podcastindex.org/namespace/1.0" xmlns:it="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:a="http://www.w3.org/2005/Atom">
<channel><title>NS</title><link>https://ns.example.com</link><a:link rel="self" href="https://ns.example.com/feed"/>
<item><title>T</title><guid>https://ns.example.com/1</guid><d:creator>Dana</d:creator><d:date>2026-05-06T07:08:09Z</d:date>
  <c:encoded><![CDATA[<p>Full content is here</p>]]></c:encoded><description>Short</description>
  <pod:transcript url="/t/1.vtt" type="text/vtt" language="en"/>
  <pod:transcript url="https://ns.example.com/t/1.srt" type="application/srt" rel="captions"/>
  <pod:transcript type="text/plain"/>
  <it:duration>62:06</it:duration><it:episode>12</it:episode></item>
</channel></rss>`;
    const entry = parseFeed(xml).entries[0];
    expect(entry?.author).toBe("Dana");
    expect(entry?.publishedAt).toBe(Date.UTC(2026, 4, 6, 7, 8, 9));
    expect(entry?.html).toBe("<p>Full content is here</p>");
    expect(entry?.text).toBe("Full content is here");
    expect(entry?.link).toBe("https://ns.example.com/1");
    expect(entry?.extra["podcast:transcript"]).toEqual([
      { url: "https://ns.example.com/t/1.vtt", type: "text/vtt", language: "en" },
      { url: "https://ns.example.com/t/1.srt", type: "application/srt", rel: "captions" },
    ]);
    expect(entry?.extra["itunes:duration"]).toBe("62:06");
    expect(entry?.extra["itunes:episode"]).toBe("12");
  });

  const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://atom.example.org/blog/">
<title type="html">Atom &amp;amp; &lt;i&gt;Co&lt;/i&gt;</title>
<link rel="self" href="feed.atom"/><link href="/"/>
<author><name>Feed Author</name></author>
<entry><id>urn:uuid:1</id><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">XHTML <b>title</b></div></title>
  <link rel="replies" href="comments/1"/><link rel="alternate" type="text/html" href="posts/1"/>
  <link rel="enclosure" type="audio/mpeg" length="1234" href="media/1.mp3"/>
  <updated>2026-01-02T03:04:05Z</updated><published>2026-01-01T00:00:00+02:00</published>
  <category term="agents" label="Agents"/><category term="evals"/>
  <summary>Short summary</summary>
  <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Para one &amp; more.</p><ul><li>Item</li></ul></div></content></entry>
<entry xml:base="https://other.example.org/base/"><title>Second</title><link href="p2"/><updated>2026-01-03</updated>
  <content type="html">&lt;p&gt;Escaped &amp;amp; fine&lt;/p&gt;</content>
  <author><name>Entry Author</name><email>e@example.org</email></author></entry>
<entry><title>Third has no link</title><summary type="text">Just text &lt;not a tag&gt;</summary></entry>
</feed>`;

  it("reads Atom: xml:base, link relations, text constructs, categories, and the enclosure", () => {
    const feed = parseFeed(ATOM, "https://ignored.example.com/feed");
    expect(feed.title).toBe("Atom & Co");
    expect(feed.siteUrl).toBe("https://atom.example.org/");
    const [first, second, third] = feed.entries;
    expect(first?.id).toBe("urn:uuid:1");
    expect(first?.title).toBe("XHTML title");
    expect(first?.link).toBe("https://atom.example.org/blog/posts/1");
    expect(first?.enclosure).toEqual({ url: "https://atom.example.org/blog/media/1.mp3", type: "audio/mpeg", length: 1234 });
    expect(first?.publishedAt).toBe(Date.parse("2026-01-01T00:00:00+02:00"));
    expect(first?.extra["updatedAt"]).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(first?.categories).toEqual(["Agents", "evals"]);
    expect(first?.author).toBe("Feed Author");
    expect(first?.html).toContain("<p>Para one &amp; more.</p>");
    expect(first?.text).toBe("Para one & more.\n\n- Item");

    expect(second?.id).toBe("https://other.example.org/base/p2");
    expect(second?.link).toBe("https://other.example.org/base/p2");
    expect(second?.author).toBe("Entry Author");
    expect(second?.publishedAt).toBe(Date.UTC(2026, 0, 3));
    expect(second?.html).toBe("<p>Escaped &amp; fine</p>");
    expect(second?.text).toBe("Escaped & fine");

    expect(third?.link).toBeUndefined();
    expect(third?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(third?.html).toBeUndefined();
    expect(third?.text).toBe("Just text <not a tag>");
    expect(third?.publishedAt).toBeUndefined();
  });

  it("reads an Atom feed whose elements have a prefix", () => {
    const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>Prefixed</a:title>
      <a:link href="https://p.example.com/"/>
      <a:entry><a:id>p-1</a:id><a:title>Entry</a:title><a:link href="/e/1"/><a:updated>2026-06-07T08:09:10Z</a:updated>
      <a:summary type="html">&lt;p&gt;Sum&lt;/p&gt;</a:summary></a:entry></a:feed>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe("Prefixed");
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toMatchObject({ id: "p-1", title: "Entry", link: "https://p.example.com/e/1", text: "Sum" });
    expect(feed.entries[0]?.publishedAt).toBe(Date.UTC(2026, 5, 7, 8, 9, 10));
  });

  it("reads RSS 1.0 (RDF)", () => {
    const xml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://rdf.example.org/"><title>RDF feed</title><link>https://rdf.example.org/</link></channel>
<item rdf:about="https://rdf.example.org/a"><title>A</title><link>https://rdf.example.org/a</link><description>Desc A</description>
  <dc:date>2026-02-03T04:05:06+01:00</dc:date><dc:subject>papers</dc:subject><dc:creator>R. Searcher</dc:creator></item>
<item rdf:about="https://rdf.example.org/b"><title>B</title><description>Desc B</description></item>
</rdf:RDF>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe("RDF feed");
    expect(feed.siteUrl).toBe("https://rdf.example.org/");
    expect(feed.entries.map((e) => [e.id, e.title, e.text])).toEqual([
      ["https://rdf.example.org/a", "A", "Desc A"],
      ["https://rdf.example.org/b", "B", "Desc B"],
    ]);
    expect(feed.entries[0]?.publishedAt).toBe(Date.parse("2026-02-03T04:05:06+01:00"));
    expect(feed.entries[0]?.categories).toEqual(["papers"]);
    expect(feed.entries[0]?.author).toBe("R. Searcher");
  });

  it("reads the fields of a JSON Feed", () => {
    const json = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JSON &amp; more",
      home_page_url: "https://j.example.com/",
      feed_url: "https://j.example.com/feeds/main.json",
      authors: [{ name: "Feed Person" }],
      items: [
        {
          id: 42,
          url: "/posts/42",
          title: "Text only",
          content_text: "Line one\nLine two <b>not markup</b>",
          date_published: "2026-04-05T06:07:08Z",
          date_modified: "2026-04-06T00:00:00Z",
          tags: ["agents", "Agents", "evals"],
          attachments: [{ url: "/audio/42.mp3", mime_type: "audio/mpeg", size_in_bytes: 999 }],
          _custom: { a: 1 },
        },
        { id: "b", external_url: "https://elsewhere.example.com/x", content_html: "<p>HTML <i>body</i></p>", authors: [{ name: "Item Person" }] },
        { summary: "Only a summary" },
        "not an item",
      ],
    });
    const feed = parseFeed(`  ${json}`);
    expect(feed.title).toBe("JSON & more");
    expect(feed.siteUrl).toBe("https://j.example.com/");
    expect(feed.entries).toHaveLength(3);
    expect(feed.entries[0]).toEqual({
      id: "42",
      title: "Text only",
      link: "https://j.example.com/posts/42",
      author: "Feed Person",
      publishedAt: Date.UTC(2026, 3, 5, 6, 7, 8),
      text: "Line one\nLine two <b>not markup</b>",
      categories: ["agents", "evals"],
      enclosure: { url: "https://j.example.com/audio/42.mp3", type: "audio/mpeg", length: 999 },
      extra: { _custom: { a: 1 }, updatedAt: Date.UTC(2026, 3, 6) },
    });
    expect(feed.entries[1]).toMatchObject({
      id: "b",
      link: "https://elsewhere.example.com/x",
      author: "Item Person",
      html: "<p>HTML <i>body</i></p>",
      text: "HTML body",
      title: "HTML body",
    });
    expect(feed.entries[1]?.publishedAt).toBeUndefined();
    expect(feed.entries[2]?.text).toBe("Only a summary");
    expect(feed.entries[2]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the entries in feed order", () => {
    const items = Array.from({ length: 30 }, (_, i) => `<item><title>Item ${i}</title><guid>g-${i}</guid></item>`).join("");
    const feed = parseFeed(`<rss version="2.0"><channel><title>Order</title>${items}</channel></rss>`);
    expect(feed.entries.map((e) => e.id)).toEqual(Array.from({ length: 30 }, (_, i) => `g-${i}`));
  });

  it("reads a feed with no entries", () => {
    expect(parseFeed('<rss version="2.0"><channel><title>Empty</title><link>https://e.example.com</link></channel></rss>')).toEqual({
      title: "Empty",
      siteUrl: "https://e.example.com",
      entries: [],
    });
    expect(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty atom</title></feed>')).toEqual({ title: "Empty atom", entries: [] });
  });

  it("does not expand entities of a DOCTYPE", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>
      <rss version="2.0"><channel><title>&b;&b;&b;</title><item><title>x &b;</title><guid>1</guid></item></channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.title.length).toBeLessThan(20);
    expect(feed.entries[0]?.title).toBe("x &b;");
  });
});

describe("parseFeed with documents that are not feeds", () => {
  it.each([
    ["an empty text", ""],
    ["spaces", "  \n\t "],
    ["plain text", "Hello, this is not a feed."],
    ["an HTML page", "<!DOCTYPE html><html><head><title>Page</title></head><body><p>Hello<br>world</body></html>"],
    ["another XML document", '<?xml version="1.0"?><sitemap><url><loc>https://x.example</loc></url></sitemap>'],
    ["an rss element with no channel", "<rss></rss>"],
    ["JSON that is not a feed", '{"status":"ok","items":"none"}'],
    ["a JSON array", '[{"title":"x"}]'],
    ["broken JSON", '{"version":"https://jsonfeed.org/version/1","items":['],
    ["an error page of a JSON API", '{"error":"Not found"}'],
  ])("throws a message for people: %s", (_name, body) => {
    expect(() => parseFeed(body)).toThrow(NOT_A_FEED_MESSAGE);
    expect(() => parseFeed(body)).toThrow(NotAFeedError);
  });

  it("has the message of the specification", () => {
    expect(NOT_A_FEED_MESSAGE).toBe("This address did not return a feed");
    expect(() => parseFeed(undefined as unknown as string)).toThrow(NotAFeedError);
  });

  it("returns the complete entries of a feed that was cut off", () => {
    const cut = '<rss version="2.0"><channel><title>Cut</title><item><title>One</title><link>https://x.example/1</link></item><item><title>Tw';
    const feed = parseFeed(cut);
    expect(feed.title).toBe("Cut");
    expect(feed.entries[0]).toMatchObject({ title: "One", link: "https://x.example/1" });
  });

  it("does not fail on broken markup inside a feed", () => {
    const xml = `<rss version="2.0"><channel><title>Broken</title>
      <item><title>Bad & ampersand <3</title><description><p>unclosed <b>bold</description><guid>b-1</guid></item>
      <item><title>After</title><guid>b-2</guid></item></channel></rss>`;
    let feed: ReturnType<typeof parseFeed> | undefined;
    try {
      feed = parseFeed(xml);
    } catch (error) {
      expect(error).toBeInstanceOf(NotAFeedError);
    }
    if (feed !== undefined) expect(feed.title).toBe("Broken");
  });
});

describe("parseDate", () => {
  it("reads RFC 822 dates", () => {
    const expected = Date.UTC(2026, 10, 19, 19, 53, 30);
    expect(parseDate("Thu, 19 Nov 2026 19:53:30 +0000")).toBe(expected);
    expect(parseDate("Thu, 19 Nov 2026 19:53:30 GMT")).toBe(expected);
    expect(parseDate("19 Nov 2026 19:53:30 Z")).toBe(expected);
    expect(parseDate("Thu, 19 Nov 2026 14:53:30 EST")).toBe(expected);
    expect(parseDate("Thu, 19 Nov 2026 11:53:30 PST")).toBe(expected);
    expect(parseDate("Thu, 19 Nov 2026 05:00:00 -0500")).toBe(Date.UTC(2026, 10, 19, 10, 0, 0));
    expect(parseDate("Fri, 20 Nov 2026 01:23:30 +05:30")).toBe(expected);
    expect(parseDate("19 Nov 2026 19:53")).toBe(Date.UTC(2026, 10, 19, 19, 53, 0));
    expect(parseDate("Thu, 19 Nov 26 19:53:30 +0000")).toBe(expected);
    expect(parseDate("  Thursday, 19 November 2026 19:53:30 UT ")).toBe(expected);
  });

  it("reads ISO 8601 dates", () => {
    expect(parseDate("2026-11-19T22:14:41Z")).toBe(Date.UTC(2026, 10, 19, 22, 14, 41));
    expect(parseDate("2026-11-19T22:14:41.123+01:00")).toBe(Date.UTC(2026, 10, 19, 21, 14, 41, 123));
    expect(parseDate("2026-11-19T22:14:41-0800")).toBe(Date.UTC(2026, 10, 20, 6, 14, 41));
    expect(parseDate("2026-11-19")).toBe(Date.UTC(2026, 10, 19));
    // No zone: UTC, so that the result is the same on every machine.
    expect(parseDate("2026-11-19T10:00:00")).toBe(Date.UTC(2026, 10, 19, 10, 0, 0));
    expect(parseDate("2026-11-19 10:00:00")).toBe(Date.UTC(2026, 10, 19, 10, 0, 0));
    expect(parseDate("2026-11")).toBe(Date.UTC(2026, 10, 1));
  });

  it('reads "Month day, year" dates', () => {
    expect(parseDate("November 19, 2026")).toBe(Date.UTC(2026, 10, 19));
    expect(parseDate("Nov 6, 2026 14:30 GMT")).toBe(Date.UTC(2026, 10, 6, 14, 30));
  });

  it("returns undefined for a value that is not a valid date", () => {
    for (const bad of ["", "   ", "yesterday", "not a date", "0001-01-01T00:00:00Z", "2026-13-45", "32 Foo 2026", "2026-11-19T99:00:00Z", "x".repeat(200)]) {
      expect(parseDate(bad)).toBeUndefined();
    }
    expect(parseDate(undefined)).toBeUndefined();
    expect(parseDate(null)).toBeUndefined();
    expect(parseDate(1795126481000)).toBeUndefined();
  });
});

describe("parseDuration", () => {
  it("reads the duration forms of podcast feeds as seconds", () => {
    expect(parseDuration("01:02:06")).toBe(3726);
    expect(parseDuration("62:06")).toBe(3726);
    expect(parseDuration("2695")).toBe(2695);
    expect(parseDuration(" 55:36 ")).toBe(3336);
    expect(parseDuration(90)).toBe(90);
  });

  it("returns undefined for other values", () => {
    expect(parseDuration("abc")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("1:2:3:4")).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(-5)).toBeUndefined();
  });
});

describe("discoverFeeds", () => {
  it("finds the feeds of a real page with RSS and JSON Feed links", () => {
    expect(discoverFeeds(fixture("discover-jsonfeed-org.html"), "https://www.jsonfeed.org/")).toEqual([
      "https://www.jsonfeed.org/feed.xml",
      "https://www.jsonfeed.org/podcast.xml",
      "https://www.jsonfeed.org/feed.json",
    ]);
  });

  it("finds the feeds of a WordPress page and leaves the API links out", () => {
    expect(discoverFeeds(fixture("discover-github-blog.html"), "https://github.blog/changelog/")).toEqual([
      "https://github.blog/feed/",
      "https://github.blog/comments/feed/",
      "https://github.blog/changelog/feed/",
    ]);
  });

  it("returns nothing for a page with no feed link", () => {
    // The Cursor changelog has only language alternates.
    const cursor = readFileSync(join(__dirname, "..", "text", "__fixtures__", "cursor-changelog.html"), "utf8");
    expect(discoverFeeds(cursor, "https://cursor.com/changelog")).toEqual([]);
    expect(discoverFeeds("", "https://example.com/")).toEqual([]);
    expect(discoverFeeds("<html><body><p>No head</p></body></html>", "https://example.com/")).toEqual([]);
  });

  const PAGE = `<html><head>
    <link rel="alternate" type="application/rss+xml" href="feed.xml">
    <LINK REL="ALTERNATE" TYPE="Application/Atom+XML; charset=utf-8" HREF='/atom.xml'>
    <link rel="alternate" type="application/json" href="https://site.example.com/wp-json/wp/v2/posts/1">
    <link rel="alternate" type="application/json+oembed" href="https://site.example.com/oembed?url=x">
    <link type="application/feed+json" href="https://site.example.com/feed.json?a=1&amp;b=2" rel="alternate">
    <link rel="alternate" hreflang="de" href="https://site.example.com/de/">
    <link rel="stylesheet" href="a.css"><link rel="alternate stylesheet" type="text/css" href="b.css">
    <link rel="alternate" type="application/rss+xml" href="feed.xml">
    <link rel="alternate" type="text/xml" title="RSS Feed" href="/rss">
    <link rel="alternate" type="text/xml" title="Sitemap" href="/sitemap.xml">
    <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
    <link rel="alternate" type="application/rss+xml" href="">
    <link rel="feed alternate" type="application/atom+xml" href="https://other.example.net/all.atom">
  </head><body><a rel="alternate" type="application/rss+xml" href="/not-a-link-element.xml">x</a></body></html>`;

  it("resolves addresses against the base URL, in page order, with no duplicates", () => {
    expect(discoverFeeds(PAGE, "https://page.example.com/dir/index.html")).toEqual([
      "https://page.example.com/dir/feed.xml",
      "https://page.example.com/atom.xml",
      "https://site.example.com/feed.json?a=1&b=2",
      "https://page.example.com/rss",
      "https://other.example.net/all.atom",
    ]);
  });

  it("uses the <base> element of the page", () => {
    const withBase = PAGE.replace("<head>", '<head><base href="https://base.example.com/root/">');
    expect(discoverFeeds(withBase, "https://page.example.com/dir/index.html").slice(0, 2)).toEqual([
      "https://base.example.com/root/feed.xml",
      "https://base.example.com/atom.xml",
    ]);
  });
});
