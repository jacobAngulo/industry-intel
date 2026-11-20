import { describe, expect, it } from "vitest";

import { splitInlineCode } from "./inline-code";

describe("splitInlineCode", () => {
  it("returns plain text as one text part", () => {
    expect(splitInlineCode("No code here.")).toEqual([{ kind: "text", value: "No code here." }]);
  });

  it("returns nothing for an empty text", () => {
    expect(splitInlineCode("")).toEqual([]);
  });

  it("turns a backtick pair into a code part", () => {
    expect(splitInlineCode("Run `npm test` first.")).toEqual([
      { kind: "text", value: "Run " },
      { kind: "code", value: "npm test" },
      { kind: "text", value: " first." },
    ]);
  });

  it("handles several pairs and code at the start and the end", () => {
    expect(splitInlineCode("`a` and `b`")).toEqual([
      { kind: "code", value: "a" },
      { kind: "text", value: " and " },
      { kind: "code", value: "b" },
    ]);
  });

  it("keeps a lone backtick as text", () => {
    expect(splitInlineCode("It's a ` mark")).toEqual([{ kind: "text", value: "It's a ` mark" }]);
  });

  it("keeps an empty or blank pair as text", () => {
    expect(splitInlineCode("x `` y")).toEqual([{ kind: "text", value: "x `` y" }]);
    expect(splitInlineCode("a ` ` b")).toEqual([{ kind: "text", value: "a ` ` b" }]);
  });

  it("does not join a pair across a line break", () => {
    expect(splitInlineCode("a `b\nc` d")).toEqual([{ kind: "text", value: "a `b\nc` d" }]);
  });

  it("interprets nothing else: HTML and markdown stay text", () => {
    const text = "<b>bold</b> **x** [link](https://example.com)";
    expect(splitInlineCode(text)).toEqual([{ kind: "text", value: text }]);
  });

  it("keeps HTML inside code as the code text", () => {
    expect(splitInlineCode("Use `<script>` carefully")).toEqual([
      { kind: "text", value: "Use " },
      { kind: "code", value: "<script>" },
      { kind: "text", value: " carefully" },
    ]);
  });
});
