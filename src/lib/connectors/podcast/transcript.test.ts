import { describe, expect, it } from "vitest";

import { loadFixture } from "@/test/helpers";

import {
  htmlTranscriptToText,
  jsonTranscriptToText,
  pickTranscript,
  srtToText,
  transcriptToText,
  vttToText,
} from "./transcript";

const INTRO = /^Narrator: Welcome to the Practical AI Podcast, where we break down the real world applications/;

describe("transcript conversion (real Practical AI transcripts)", () => {
  it("WebVTT", () => {
    const text = vttToText(loadFixture("transcript.vtt"));
    expect(text).toMatch(INTRO);
    expect(text).toMatch(/practicalai\.fm\. Now onto the show\.$/);
    expect(text).not.toMatch(/WEBVTT|-->|<v /);
  });

  it("SubRip", () => {
    const text = srtToText(loadFixture("transcript.srt"));
    expect(text).toMatch(INTRO);
    expect(text).not.toMatch(/-->|^\d+$/m);
    expect(text).toMatch(/where we break down the real world applications of artificial intelligence/);
  });

  it("JSON (Podcasting 2.0 segments with body)", () => {
    const text = jsonTranscriptToText(loadFixture("transcript.json"));
    expect(text).toMatch(INTRO);
    expect(text).toMatch(/Now onto the show\.$/);
  });

  it("HTML: no <time> codes", () => {
    const text = htmlTranscriptToText(loadFixture("transcript.html"));
    expect(text).toMatch(INTRO);
    expect(text).not.toMatch(/\b00:\d\d\b/);
  });

  it("text/plain", () => {
    expect(transcriptToText(loadFixture("transcript.txt"), "text")).toMatch(INTRO);
  });
});

describe("transcript conversion (odd input)", () => {
  it("WebVTT: header, NOTE, STYLE, cue ids, inline tags, repeated lines", () => {
    const vtt = [
      "WEBVTT - Example",
      "Kind: captions",
      "",
      "NOTE This is a note",
      "that spans two lines",
      "",
      "STYLE",
      "::cue { color: lime }",
      "",
      "intro-1",
      "00:00:01.000 --> 00:00:03.000 align:start",
      "<v.loud Alice Smith>Hello <b>there</b> &amp; welcome.</v>",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "<c.yellow>Hello <00:00:03.500>there</c> &amp; welcome.",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "<v Bob>Thanks, Alice.",
      "",
    ].join("\n");
    expect(vttToText(vtt)).toBe("Alice Smith: Hello there & welcome.\n\nBob: Thanks, Alice.");
  });

  it("SubRip: style codes, CRLF, and a speaker prefix", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}<i>Dana Lee: First line</i>\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nsecond line\r\n";
    expect(srtToText(srt)).toBe("Dana Lee: First line second line");
  });

  it("a colon in a sentence is not a speaker", () => {
    expect(srtToText("1\n00:00:01,000 --> 00:00:02,000\nSo here's the thing: it works.\n")).toBe("So here's the thing: it works.");
  });

  it("JSON: invalid JSON or another shape gives ''", () => {
    expect(jsonTranscriptToText("{nope")).toBe("");
    expect(jsonTranscriptToText(JSON.stringify({ items: [] }))).toBe("");
    expect(jsonTranscriptToText(JSON.stringify({ segments: [{ body: "One." }, { speaker: 2, body: "Two." }, { body: null }] }))).toBe("One.\n\n2: Two.");
  });

  it("empty input gives ''", () => {
    expect(vttToText("")).toBe("");
    expect(srtToText("")).toBe("");
    expect(transcriptToText("", "html")).toBe("");
  });
});

describe("pickTranscript", () => {
  it("prefers text/plain, then text/vtt, then SubRip, then text/html, then JSON", () => {
    const refs = [
      { url: "https://x.example.com/t.json", type: "application/json" },
      { url: "https://x.example.com/t.html", type: "text/html" },
      { url: "https://x.example.com/t.srt", type: "application/x-subrip" },
      { url: "https://x.example.com/t.vtt", type: "text/vtt; charset=utf-8" },
    ];
    expect(pickTranscript(refs)?.format).toBe("vtt");
    expect(pickTranscript([...refs, { url: "https://x.example.com/t.txt", type: "text/plain" }])?.format).toBe("text");
    expect(pickTranscript(refs.slice(0, 3))?.format).toBe("srt");
    expect(pickTranscript([{ url: "https://x.example.com/t.srt", type: "application/srt" }])?.format).toBe("srt");
  });

  it("ignores unknown types, bad addresses, and odd values", () => {
    expect(pickTranscript([{ url: "https://x.example.com/t.pdf", type: "application/pdf" }])).toBeNull();
    expect(pickTranscript([{ url: "ftp://x.example.com/t.txt", type: "text/plain" }])).toBeNull();
    expect(pickTranscript(undefined)).toBeNull();
    expect(pickTranscript("text")).toBeNull();
    expect(pickTranscript([null, 3, { type: "text/plain" }])).toBeNull();
  });
});
