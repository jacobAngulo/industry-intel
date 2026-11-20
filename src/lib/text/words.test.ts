import { describe, expect, it } from "vitest";

import { normalizeForHash, sha, significantWords, slugify, stripInvisible, truncate } from "./index";

describe("stripInvisible", () => {
  it("removes zero-width characters, the soft hyphen, and the byte order mark", () => {
    expect(stripInvisible("﻿a​b‌c‍d⁠e­f")).toBe("abcdef");
  });

  it("removes bidirectional control characters", () => {
    expect(stripInvisible("a‮b‬c‎d‏e⁦f⁩g؜h")).toBe("abcdefgh");
  });

  it("removes control characters and keeps newline and tab", () => {
    expect(stripInvisible("a\u0000b\u0007c\u001Bd\u007Fe\u0085f\tg\nh")).toBe("abcdef\tg\nh");
    expect(stripInvisible("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("removes the Unicode tag characters and invisible fillers", () => {
    expect(stripInvisible("x\u{E0041}\u{E0042}\u{E007F}y͏ㅤz")).toBe("xyz");
  });

  it("leaves visible text of every script as it is", () => {
    const text = "Ünïcödé 東京 Москва 🚀 emoji — “quotes”";
    expect(stripInvisible(text)).toBe(text);
    expect(stripInvisible("")).toBe("");
    expect(stripInvisible(undefined as unknown as string)).toBe("");
  });
});

describe("truncate", () => {
  it("returns a short text unchanged", () => {
    expect(truncate("hello world", 20)).toBe("hello world");
    expect(truncate("exact", 5)).toBe("exact");
    expect(truncate("", 5)).toBe("");
  });

  it("cuts at a word border when one is near", () => {
    expect(truncate("The quick brown fox jumps", 12)).toBe("The quick…");
    expect(truncate("Hello, world again", 8)).toBe("Hello…");
  });

  it("cuts inside a long word", () => {
    expect(truncate("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
  });

  it("handles small limits", () => {
    expect(truncate("hello", 0)).toBe("");
    expect(truncate("hello", -3)).toBe("");
    expect(truncate("hello", 1)).toBe("…");
    expect(truncate("hello", 2)).toBe("h…");
  });

  it("does not cut a surrogate pair in two", () => {
    expect(truncate("ab😀cd", 4)).toBe("ab…");
  });

  it("never returns more than n characters", () => {
    const text = "Agents, tools, and evaluations: a long headline (with punctuation) that must be cut somewhere.";
    for (let n = 0; n <= text.length + 2; n++) {
      const out = truncate(text, n);
      expect(out.length).toBeLessThanOrEqual(n);
      if (n >= text.length) expect(out).toBe(text);
      else if (n > 0) expect(out.endsWith("…")).toBe(true);
    }
  });
});

describe("significantWords", () => {
  it("returns lower-case words with no stop words and no duplicates, in order", () => {
    expect(significantWords("The new GPT5 model and v2.1 of Claude's API don't break the API")).toEqual([
      "gpt5", "model", "v2.1", "claude", "api", "break",
    ]);
  });

  it("drops words under 3 characters unless they hold a digit", () => {
    expect(significantWords("AI is in v2 at 5 pm")).toEqual(["v2", "5"]);
  });

  it("splits on characters that are not letters or digits", () => {
    expect(significantWords("agent-evaluation, document_processing/papers (code)")).toEqual([
      "agent", "evaluation", "document", "processing", "papers", "code",
    ]);
    expect(significantWords("Claude Code v2.1.329 released; gpt-5.5 next")).toEqual([
      "claude", "code", "v2.1.329", "released", "gpt", "5.5", "next",
    ]);
  });

  it("keeps letters of all scripts", () => {
    expect(significantWords("Künstliche Intelligenz für 東京都 и Москва")).toEqual([
      "künstliche", "intelligenz", "für", "東京都", "москва",
    ]);
  });

  it("returns an empty list for text with no words", () => {
    expect(significantWords("")).toEqual([]);
    expect(significantWords("the of and — !!")).toEqual([]);
  });
});

describe("normalizeForHash", () => {
  it("gives lower case, no punctuation, single spaces", () => {
    expect(normalizeForHash("  Hello,   WORLD!  It’s “fine”… ")).toBe("hello world its fine");
  });

  it("gives the same result for cosmetic edits", () => {
    expect(normalizeForHash("Agents — now with tools.")).toBe(normalizeForHash("agents now with tools"));
    expect(normalizeForHash("Use `foo` (preview)")).toBe(normalizeForHash("Use foo — preview"));
    expect(normalizeForHash("line one\n\nline two")).toBe("line one line two");
  });

  it("keeps a change of a digit visible", () => {
    expect(normalizeForHash("Limit: 1.5 GB")).not.toBe(normalizeForHash("Limit: 15 GB"));
    expect(normalizeForHash("version 2")).not.toBe(normalizeForHash("version 3"));
  });

  it("handles empty input", () => {
    expect(normalizeForHash("")).toBe("");
    expect(normalizeForHash(" .,;!? ")).toBe("");
  });
});

describe("sha", () => {
  it("returns the SHA-256 of the text as hex", () => {
    expect(sha("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha("é")).not.toBe(sha("e"));
  });
});

describe("slugify", () => {
  it("gives lower-case words joined with a hyphen", () => {
    expect(slugify("Agentic Development")).toBe("agentic-development");
    expect(slugify("Internal AI Platform")).toBe("internal-ai-platform");
    expect(slugify("  What's New?! ")).toBe("whats-new");
    expect(slugify("All-In with Chamath, Jason, Sacks & Friedberg")).toBe("all-in-with-chamath-jason-sacks-friedberg");
  });

  it("removes accents and keeps letters of other scripts", () => {
    expect(slugify("Café Münster")).toBe("cafe-munster");
    expect(slugify("東京 ニュース")).toBe("東京-ニュース");
  });

  it('falls back to "item"', () => {
    expect(slugify("")).toBe("item");
    expect(slugify("!!! ???")).toBe("item");
    expect(slugify(undefined as unknown as string)).toBe("item");
  });

  it("returns at most 60 characters and no hyphen at the end", () => {
    const long = slugify("A very long feed name that goes on and on about agents, evaluations, and document processing");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect("a-very-long-feed-name-that-goes-on-and-on-about-agents-evaluations-and-document-processing".startsWith(long)).toBe(true);
    expect(slugify("x".repeat(200))).toBe("x".repeat(60));
  });
});
