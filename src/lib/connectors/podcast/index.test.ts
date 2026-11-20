import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { FakeHttp, loadFixture, makeConnectorContext } from "@/test/helpers";

import { ConnectorError } from "../types";
import { ITUNES_LOOKUP, ITUNES_SEARCH, SPOTIFY_OEMBED, appleIdOf, nameMatch, spotifyShowIdOf } from "./directory";
import { PODCAST_FEED_MAX_BYTES, connector } from "./index";

const ALL_IN_FEED = "https://rss.libsyn.com/shows/254861/destinations/1928300.xml";
const SPOTIFY_SHOW = "https://open.spotify.com/show/2IqXAVFR4e0Bmyjsdc8QzF";
const APPLE_LINK = "https://podcasts.apple.com/us/podcast/all-in-with-chamath-jason-sacks-friedberg/id1502871393";
const NOW = Date.UTC(2026, 10, 20, 12);

const allInConfig = {
  feedUrl: ALL_IN_FEED,
  show: "All-In with Chamath, Jason, Sacks & Friedberg",
  itunesId: 1502871393,
  transcripts: true,
};

function ctxWith(http: FakeHttp, now = NOW) {
  return makeConnectorContext({ http, now: () => now });
}

function directoryHttp() {
  return new FakeHttp()
    .onPrefix(ITUNES_SEARCH, { text: loadFixture("itunes-search-all-in.json"), headers: { "content-type": "text/javascript; charset=utf-8" } })
    .onPrefix(ITUNES_LOOKUP, { text: loadFixture("itunes-lookup-all-in.json"), headers: { "content-type": "text/javascript; charset=utf-8" } });
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

describe("podcast resolve", () => {
  it('resolves the name "All-In" through the Apple directory search (a low-confidence guess)', async () => {
    const http = directoryHttp();
    const found = await connector.resolve("All-In", ctxWith(http), false);
    expect(http.urls).toEqual([`${ITUNES_SEARCH}?media=podcast&limit=3&term=All-In`]);
    expect(found[0]).toMatchObject({
      type: "podcast",
      name: "All-In with Chamath, Jason, Sacks & Friedberg",
      config: allInConfig,
    });
    expect(found[0]!.confidence).toBeGreaterThan(0.3);
    expect(found[0]!.confidence).toBeLessThanOrEqual(0.4);
    for (const c of found) expect(connector.configSchema.safeParse(c.config).success).toBe(true);
  });

  it("with the Podcast type forced, the same name gives a strong first candidate", async () => {
    const found = await connector.resolve("All-In", ctxWith(directoryHttp()), true);
    expect(found[0]?.config).toMatchObject({ itunesId: 1502871393 });
    expect(found[0]!.confidence).toBeGreaterThan(0.8);
    expect(found.length).toBe(5);
  });

  it("resolves an Apple Podcasts link through the lookup", async () => {
    const http = directoryHttp();
    const found = await connector.resolve(APPLE_LINK, ctxWith(http), false);
    expect(http.urls).toEqual([`${ITUNES_LOOKUP}?id=1502871393`]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ confidence: 0.95, config: allInConfig });
    expect(found[0]?.url).toBe("https://podcasts.apple.com/us/podcast/all-in-with-chamath-jason-sacks-friedberg/id1502871393");
  });

  it("resolves a Spotify show link: the show page title, then the directory search", async () => {
    const http = directoryHttp().on(SPOTIFY_SHOW, { text: loadFixture("spotify-show-all-in.html") });
    const found = await connector.resolve(`${SPOTIFY_SHOW}?si=abc123`, ctxWith(http), false);
    expect(http.urls[0]).toBe(SPOTIFY_SHOW);
    expect(http.urls[1]).toBe(`${ITUNES_SEARCH}?media=podcast&limit=5&term=${encodeURIComponent("All-In with Chamath, Jason, Sacks & Friedberg")}`);
    expect(found[0]).toMatchObject({ confidence: 0.9, config: allInConfig });
    expect(found[0]?.warnings?.[0]).toMatch(/Spotify show title/);
    expect(http.count(/oembed/)).toBe(0);
  });

  it("falls back to oEmbed when the Spotify page fails; oEmbed gives an episode title, so the confidence is low", async () => {
    const http = directoryHttp()
      .on(SPOTIFY_SHOW, { status: 500, text: "" })
      .onPrefix(SPOTIFY_OEMBED, { text: loadFixture("spotify-oembed-all-in.json") });
    const found = await connector.resolve(SPOTIFY_SHOW, ctxWith(http), false);
    expect(http.urls[1]).toBe(`${SPOTIFY_OEMBED}?url=${encodeURIComponent(SPOTIFY_SHOW)}`);
    expect(found.every((c) => c.confidence <= 0.4)).toBe(true);
    expect(found[0]?.warnings?.[0]).toMatch(/only the title of an episode/);
  });

  it("resolves a feed address directly", async () => {
    const http = new FakeHttp().on(ALL_IN_FEED, { text: loadFixture("all-in-feed.xml") });
    const found = await connector.resolve(ALL_IN_FEED, ctxWith(http), false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: "All-In with Chamath, Jason, Sacks & Friedberg",
      confidence: 0.95,
      config: { feedUrl: ALL_IN_FEED, transcripts: true },
    });
    expect(found[0]?.description).toMatch(/Show notes only/);
    expect(http.requests[0]?.maxBytes).toBe(PODCAST_FEED_MAX_BYTES);
  });

  it("a feed with transcripts says so", async () => {
    const http = new FakeHttp().on("https://feeds.example.com/practical.xml", { text: loadFixture("practical-ai-feed.xml") });
    const [c] = await connector.resolve("https://feeds.example.com/practical.xml", ctxWith(http), false);
    expect(c?.description).toMatch(/Episodes have transcripts/);
  });

  it("returns [] for a blog feed, a handle, a sender, a Spotify episode, and other hosts", async () => {
    const http = new FakeHttp().on("https://blog.example.com/feed", { text: loadFixture("../../blog/__fixtures__/foundry-feed.xml") });
    expect(await connector.resolve("https://blog.example.com/feed", ctxWith(http), false)).toEqual([]);
    const quiet = new FakeHttp();
    for (const input of ["@chamath", "news@example.com", "x", "a".repeat(101), "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk", "https://www.youtube.com/@allin", "https://example.com/about"]) {
      expect(await connector.resolve(input, ctxWith(quiet), false)).toEqual([]);
    }
    expect(quiet.requests).toHaveLength(0);
  });

  it("directory errors are ConnectorErrors", async () => {
    await expectError(connector.resolve("All-In", ctxWith(new FakeHttp().onPrefix(ITUNES_SEARCH, { status: 503 })), true), "network");
    await expectError(connector.resolve("All-In", ctxWith(new FakeHttp().onPrefix(ITUNES_SEARCH, { text: "<html>" })), true), "bad_response");
  });

  it("link helpers", () => {
    expect(appleIdOf(new URL("https://podcasts.apple.com/podcast/id1502871393?i=1000"))).toBe(1502871393);
    expect(appleIdOf(new URL("https://example.com/id1502871393"))).toBeNull();
    expect(spotifyShowIdOf(new URL("https://open.spotify.com/intl-de/show/2IqXAVFR4e0Bmyjsdc8QzF"))).toBe("2IqXAVFR4e0Bmyjsdc8QzF");
    expect(spotifyShowIdOf(new URL("https://open.spotify.com/episode/2IqXAVFR4e0Bmyjsdc8QzF"))).toBeNull();
    expect(nameMatch("All-In", { name: "All In" })).toBe(1);
    expect(nameMatch("All-In", { name: "Ballin" })).toBe(0);
  });
});

describe("podcast fetch", () => {
  it("first poll of All-In: episodes with show notes, basis show_notes, the duration, and the validators", async () => {
    const http = new FakeHttp().on(ALL_IN_FEED, { text: loadFixture("all-in-feed.xml"), etag: 'W/"7581c5ad"', lastModified: "Tue, 17 Nov 2026 22:20:02 GMT" });
    const result = await connector.fetch({ config: allInConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.kind).toBe("episode");
      expect(item.meta?.basis).toBe("show_notes");
      expect(item.meta?.durationSeconds).toBeGreaterThan(600);
      expect(item.text.length).toBeGreaterThan(50);
      expect(item.text).not.toMatch(/<\/?p>/);
    }
    expect(result.items[0]!.publishedAt).toBeGreaterThan(result.items[1]!.publishedAt!);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.maxBytes).toBe(PODCAST_FEED_MAX_BYTES);
    expect(result.cursor).toMatchObject({ etag: 'W/"7581c5ad"', lastModified: "Tue, 17 Nov 2026 22:20:02 GMT" });
  });

  it("not modified (304), then a later poll with a cursor", async () => {
    const http = new FakeHttp().on(ALL_IN_FEED, { text: loadFixture("all-in-feed.xml"), etag: '"e1"' });
    const first = await connector.fetch({ config: allInConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    const same = await connector.fetch({ config: allInConfig, cursor: first.cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(same.items).toEqual([]);
    expect(same.cursor).toEqual(first.cursor);
    const newest = first.items[0]!.externalId;
    const cursor = { seenIds: first.cursor!.seenIds.filter((id) => id !== newest) };
    const later = await connector.fetch({ config: allInConfig, cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(later.items.map((i) => i.externalId)).toEqual([newest]);
  });

  function transcriptHttp() {
    return new FakeHttp()
      .on("https://show.example.com/feed.xml", { text: loadFixture("transcripts.synthetic.xml") })
      .onPrefix("https://cdn.example.com/", (req) => {
        const ext = req.url.split(".").pop();
        const file = { txt: "transcript.txt", vtt: "transcript.vtt", srt: "transcript.srt", json: "transcript.json", html: "transcript.html" }[ext ?? ""];
        return file ? { text: loadFixture(file) } : { status: 404 };
      });
  }
  const showConfig = { feedUrl: "https://show.example.com/feed.xml", show: "Example Show", transcripts: true };

  it("fetches the transcript of the 8 newest episodes, in the preferred format, as plain text", async () => {
    const http = transcriptHttp();
    const result = await connector.fetch({ config: showConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.title.split(":")[0])).toEqual([
      "Episode 10", "Episode 9", "Episode 8", "Episode 7", "Episode 6", "Episode 5", "Episode 4", "Episode 3", "Episode 2", "Episode 1",
    ]);
    expect(http.urls.filter((u) => u.startsWith("https://cdn.example.com/"))).toEqual([
      "https://cdn.example.com/ep10.txt", // text/plain first
      "https://cdn.example.com/ep9.vtt", // then text/vtt
      "https://cdn.example.com/ep8.srt", // then SubRip
      "https://cdn.example.com/ep7.html", // then text/html
      "https://cdn.example.com/ep6.json", // then JSON
      // ep5 has only a PDF: no fetch
      "https://cdn.example.com/ep4.txt",
      "https://cdn.example.com/ep3.txt",
      // ep2 and ep1 are not among the 8 newest
    ]);
    const basis = result.items.map((i) => i.meta?.basis);
    expect(basis).toEqual(["transcript", "transcript", "transcript", "transcript", "transcript", "show_notes", "transcript", "transcript", "show_notes", "show_notes"]);
    for (const item of result.items.filter((i) => i.meta?.basis === "transcript")) {
      expect(item.text).toMatch(/Welcome to the Practical AI Podcast/);
      expect(item.text).toMatch(/Now onto the show\./);
      expect(item.text).not.toMatch(/-->|WEBVTT|\b00:0\d\b|^\d+$/m);
      expect(item.meta?.showNotes).toMatch(/Show notes of episode/);
    }
    expect(result.items[0]?.meta?.durationSeconds).toBe(3000);
    expect(result.items[0]?.links).toEqual(["https://tools.example.org/eval-10"]);
  });

  it("fetches no transcript for an episode older than 14 days", async () => {
    const http = transcriptHttp();
    const result = await connector.fetch({ config: showConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http, Date.UTC(2026, 11, 1)) });
    expect(http.urls.filter((u) => u.startsWith("https://cdn.example.com/"))).toEqual([
      "https://cdn.example.com/ep10.txt",
      "https://cdn.example.com/ep9.vtt",
      "https://cdn.example.com/ep8.srt",
    ]);
    expect(result.items[3]?.meta?.basis).toBe("show_notes");
  });

  it("transcripts off: no transcript request", async () => {
    const http = transcriptHttp();
    await connector.fetch({ config: { ...showConfig, transcripts: false }, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(http.count(/cdn\.example\.com/)).toBe(0);
  });

  it("preview: at most 3 transcripts and no cursor", async () => {
    const http = transcriptHttp();
    const result = await connector.fetch({ config: showConfig, cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http) });
    expect(http.count(/cdn\.example\.com/)).toBe(3);
    expect(result.cursor).toBeNull();
  });

  it("a transcript that fails leaves the show notes", async () => {
    const http = new FakeHttp()
      .on("https://show.example.com/feed.xml", { text: loadFixture("transcripts.synthetic.xml") })
      .onPrefix("https://cdn.example.com/ep10", { error: new HttpError("timeout", "slow") })
      .onPrefix("https://cdn.example.com/ep9", { status: 404 })
      .onPrefix("https://cdn.example.com/", { text: "too short" });
    const result = await connector.fetch({ config: showConfig, cursor: null, mode: "poll", limit: 3, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.meta?.basis)).toEqual(["show_notes", "show_notes", "show_notes"]);
    expect(result.items[0]?.text).toMatch(/Show notes of episode 10/);
  });

  it("reads the real Practical AI feed and its text/plain transcripts", async () => {
    const http = new FakeHttp()
      .on("https://feeds.example.com/practical.xml", { text: loadFixture("practical-ai-feed.xml") })
      .onPrefix("https://share.transistor.fm/", { text: loadFixture("transcript.txt") });
    const result = await connector.fetch({
      config: { ...showConfig, feedUrl: "https://feeds.example.com/practical.xml" },
      cursor: null,
      mode: "poll",
      limit: 30,
      // The older episode (5 Nov) is inside the 14 days on 19 Nov.
      ctx: ctxWith(http, Date.UTC(2026, 10, 19, 9)),
    });
    expect(result.items).toHaveLength(2);
    expect(http.urls.filter((u) => u.includes("transistor"))).toEqual([
      "https://share.transistor.fm/s/bb4dad17/transcription.txt",
      "https://share.transistor.fm/s/1b301bdc/transcription.txt",
    ]);
    expect(result.items[0]?.meta).toMatchObject({ basis: "transcript", durationSeconds: 2695 });
  });

  it.each([
    [{ status: 404 }, "not_found", /The podcast feed returned 404/],
    [{ status: 403 }, "blocked", /refused/],
    [{ text: "<html></html>" }, "bad_response", /did not return a feed/],
    [{ error: new HttpError("too_large", "x") }, "bad_response", /size limit/],
  ] as const)("feed error %o -> %s", async (reply, kind, text) => {
    const http = new FakeHttp().on(ALL_IN_FEED, reply);
    await expectError(connector.fetch({ config: allInConfig, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }), kind, text);
  });
});
