import { describe, expect, it } from "vitest";

import { FakeHttp, loadFixture, makeConnectorContext } from "@/test/helpers";

import { ConnectorError } from "../types";
import { channelFeedUrl, channelOfVideoPage, connector, parseYoutubeUrl, playlistFeedUrl } from "./index";

const ALL_IN = "UCESLZhusAkFfsNsApnjF_Cg";
const GOOGLE_DEV = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const PLAYLIST = "PLOU2XLYxmsILZpGc5gWRO1vL0n9CtcPJL";
const VIDEO = "1bR0gtecoHU";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;

function ctxWith(http: FakeHttp) {
  return makeConnectorContext({ http, now: () => Date.UTC(2026, 10, 20) });
}

function youtubeHttp() {
  return new FakeHttp()
    .on("https://www.youtube.com/@allin", { text: loadFixture("handle-allin.html") })
    .on("https://www.youtube.com/c/GoogleDevelopers", { text: loadFixture("c-googledevelopers.html") })
    .on("https://www.youtube.com/user/GoogleDevelopers", { text: loadFixture("user-googledevelopers.html") })
    .on(WATCH, { text: loadFixture("watch-allin.html") })
    .on(channelFeedUrl(ALL_IN), { text: loadFixture("feed-allin.xml") })
    .on(playlistFeedUrl(PLAYLIST), { text: loadFixture("feed-playlist.xml") });
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

describe("youtube resolve", () => {
  it("a /@handle link: the channel id and the name from the channel page (one request)", async () => {
    const http = youtubeHttp();
    const found = await connector.resolve("https://www.youtube.com/@allin", ctxWith(http), false);
    expect(found).toEqual([
      expect.objectContaining({
        type: "youtube",
        name: "All-In Podcast",
        confidence: 0.95,
        url: `https://www.youtube.com/channel/${ALL_IN}`,
        config: { variant: "channel", channelId: ALL_IN, title: "All-In Podcast", includeShorts: false },
      }),
    ]);
    expect(http.urls).toEqual(["https://www.youtube.com/@allin"]);
  });

  it.each(["https://www.youtube.com/c/GoogleDevelopers", "youtube.com/user/GoogleDevelopers"])("a legacy link %s", async (input) => {
    const found = await connector.resolve(input, ctxWith(youtubeHttp()), false);
    expect(found[0]).toMatchObject({ name: "Google for Developers", config: { channelId: GOOGLE_DEV } });
  });

  it("a /channel/UC… link: the title from the channel feed", async () => {
    const found = await connector.resolve(`https://www.youtube.com/channel/${ALL_IN}/videos`, ctxWith(youtubeHttp()), false);
    expect(found[0]).toMatchObject({ name: "All-In Podcast", confidence: 0.95, config: { channelId: ALL_IN } });
  });

  it("a /channel/UC… link whose feed does not answer still gives a candidate, with a warning", async () => {
    const http = new FakeHttp().on(channelFeedUrl(ALL_IN), { status: 500 });
    const found = await connector.resolve(`https://youtube.com/channel/${ALL_IN}`, ctxWith(http), false);
    expect(found[0]).toMatchObject({ confidence: 0.7, name: `YouTube channel ${ALL_IN}` });
    expect(found[0]?.warnings?.[0]).toMatch(/did not answer/);
  });

  it("a playlist link: the title from the playlist feed", async () => {
    const found = await connector.resolve(`https://www.youtube.com/playlist?list=${PLAYLIST}`, ctxWith(youtubeHttp()), false);
    expect(found).toEqual([
      expect.objectContaining({
        name: "New releases: Inside Google’s latest models",
        confidence: 0.95,
        config: { variant: "playlist", playlistId: PLAYLIST, title: "New releases: Inside Google’s latest models" },
      }),
    ]);
  });

  it("a private or missing playlist (feed 404) gives no candidate", async () => {
    const http = new FakeHttp().on(playlistFeedUrl("PLzzzzzzzzzzzzzzzz"), { status: 404, text: loadFixture("not-found.html") });
    expect(await connector.resolve("https://www.youtube.com/playlist?list=PLzzzzzzzzzzzzzzzz", ctxWith(http), false)).toEqual([]);
  });

  it.each([WATCH, `https://youtu.be/${VIDEO}?si=x`, `https://www.youtube.com/shorts/${VIDEO}`, `https://www.youtube.com/live/${VIDEO}`, `https://m.youtube.com/watch?v=${VIDEO}&t=10s`])(
    "a video link %s gives the channel of the video",
    async (input) => {
      const http = youtubeHttp();
      const found = await connector.resolve(input, ctxWith(http), false);
      expect(found).toEqual([expect.objectContaining({ name: "All-In Podcast", confidence: 0.9, config: expect.objectContaining({ channelId: ALL_IN }) })]);
      expect(http.urls).toEqual([WATCH, channelFeedUrl(ALL_IN)]);
    },
  );

  it("a video link inside a playlist gives the channel and the playlist", async () => {
    const found = await connector.resolve(`${WATCH}&list=${PLAYLIST}`, ctxWith(youtubeHttp()), false);
    expect(found.map((c) => (c.config as { variant: string }).variant)).toEqual(["channel", "playlist"]);
  });

  it("the YouTube consent page is reported as blocked", async () => {
    const http = new FakeHttp().on("https://www.youtube.com/@allin", { text: "<html>Before you continue</html>", url: "https://consent.youtube.com/m?continue=x" });
    await expectError(connector.resolve("https://www.youtube.com/@allin", ctxWith(http), false), "blocked", /consent/);
  });

  it("an unknown handle (404) and a page with no channel id are errors", async () => {
    const http = new FakeHttp()
      .on("https://www.youtube.com/@nobody-zz9", { status: 404, text: "" })
      .on("https://www.youtube.com/@empty", { text: "<html><head><title>x</title></head></html>" });
    await expectError(connector.resolve("https://www.youtube.com/@nobody-zz9", ctxWith(http), false), "not_found", /404/);
    await expectError(connector.resolve("https://www.youtube.com/@empty", ctxWith(http), false), "bad_response", /channel id/);
  });

  it("other input gives [] with no request; a handle or a channel id counts only when the type is forced", async () => {
    const http = new FakeHttp();
    for (const input of ["@allin", "All-In", "https://example.com/@allin", "https://www.youtube.com/", "https://www.youtube.com/feed/trending", ALL_IN]) {
      expect(await connector.resolve(input, ctxWith(http), false)).toEqual([]);
    }
    expect(http.requests).toHaveLength(0);
    const forced = await connector.resolve("@allin", ctxWith(youtubeHttp()), true);
    expect(forced[0]?.config).toMatchObject({ channelId: ALL_IN });
    const byId = await connector.resolve(ALL_IN, ctxWith(youtubeHttp()), true);
    expect(byId[0]?.name).toBe("All-In Podcast");
  });

  it("parseYoutubeUrl and channelOfVideoPage", () => {
    expect(parseYoutubeUrl(new URL("https://www.youtube.com/watch?list=" + PLAYLIST))).toEqual({ kind: "playlist", playlistId: PLAYLIST });
    expect(parseYoutubeUrl(new URL("https://www.youtube.com/watch?v=short"))).toBeNull();
    expect(parseYoutubeUrl(new URL("https://youtu.be/"))).toBeNull();
    const page = `"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa" x "videoDetails":{"videoId":"x","channelId":"${ALL_IN}"} "channelId":"UCaaaaaaaaaaaaaaaaaaaaaa"`;
    expect(channelOfVideoPage(page)).toBe(ALL_IN);
    expect(channelOfVideoPage(`"channelId":"${GOOGLE_DEV}" "channelId":"${GOOGLE_DEV}" "channelId":"${ALL_IN}"`)).toBe(GOOGLE_DEV);
    expect(channelOfVideoPage("nothing")).toBeNull();
  });
});

describe("youtube fetch", () => {
  const channel = { variant: "channel" as const, channelId: ALL_IN, title: "All-In Podcast", includeShorts: false };

  it("a channel without Shorts: the long videos only, as plain text with stable ids", async () => {
    const http = youtubeHttp();
    const result = await connector.fetch({ config: channel, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(4);
    for (const item of result.items) {
      expect(item.kind).toBe("video");
      expect(item.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
      expect(item.externalId).toMatch(/^yt:video:[\w-]{11}$/);
      expect(item.meta?.short).toBe(false);
      expect(item.text).not.toMatch(/<[a-z]/i);
    }
    expect(result.items[0]).toMatchObject({ externalId: `yt:video:${VIDEO}`, author: "All-In Podcast", meta: { videoId: VIDEO } });
    expect(result.items[0]?.text).toMatch(/Ali Ghodsi/);
    // The Shorts count as seen, so switching them on later does not bring back old ones.
    expect(result.cursor?.seenIds).toHaveLength(15);
  });

  it("includeShorts: every video, Shorts marked", async () => {
    const result = await connector.fetch({ config: { ...channel, includeShorts: true }, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(youtubeHttp()) });
    expect(result.items).toHaveLength(15);
    expect(result.items.filter((i) => i.meta?.short === true)).toHaveLength(11);
  });

  it("a playlist: every entry", async () => {
    const config = { variant: "playlist" as const, playlistId: PLAYLIST, title: "x" };
    const result = await connector.fetch({ config, cursor: null, mode: "preview", limit: 10, ctx: ctxWith(youtubeHttp()) });
    expect(result.items).toHaveLength(4);
    expect(result.cursor).toBeNull();
  });

  it("a later poll returns only new videos; not modified keeps the cursor", async () => {
    const http = youtubeHttp();
    const first = await connector.fetch({ config: channel, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    const newest = first.items[0]!.externalId;
    const later = await connector.fetch({
      config: channel,
      cursor: { seenIds: first.cursor!.seenIds.filter((id) => id !== newest) },
      mode: "poll",
      limit: 30,
      ctx: ctxWith(http),
    });
    expect(later.items.map((i) => i.externalId)).toEqual([newest]);

    const cached = new FakeHttp().on(channelFeedUrl(ALL_IN), { text: loadFixture("feed-allin.xml"), lastModified: "Fri, 20 Nov 2026 08:00:00 GMT" });
    const same = await connector.fetch({
      config: channel,
      cursor: { lastModified: "Fri, 20 Nov 2026 08:00:00 GMT", seenIds: ["a"] },
      mode: "poll",
      limit: 30,
      ctx: ctxWith(cached),
    });
    expect(same).toEqual({ items: [], cursor: { lastModified: "Fri, 20 Nov 2026 08:00:00 GMT", seenIds: ["a"] } });
  });

  it.each([
    [{ status: 404, text: "<html>404</html>" }, "not_found", /The YouTube channel feed returned 404/],
    [{ status: 500 }, "network", /500/],
    [{ text: "<html></html>" }, "bad_response", /did not return a feed/],
  ] as const)("feed error %o -> %s", async (reply, kind, text) => {
    const http = new FakeHttp().on(channelFeedUrl(ALL_IN), reply);
    await expectError(connector.fetch({ config: channel, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }), kind, text);
  });

  it("keyOf", () => {
    expect(connector.keyOf(channel)).toBe(`youtube:channel:${ALL_IN}`);
    expect(connector.keyOf({ variant: "playlist", playlistId: PLAYLIST, title: "x" })).toBe(`youtube:playlist:${PLAYLIST}`);
  });
});
