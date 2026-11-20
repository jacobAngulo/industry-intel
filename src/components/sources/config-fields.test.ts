import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configSchemas, parseConfig } from "@/lib/connectors/configs";
import { SOURCE_TYPES, type SourceType } from "@/lib/types";

import {
  checkConfig,
  configFields,
  listToText,
  numberFieldValue,
  setConfigValue,
  textFieldValue,
  textToList,
  variantLabel,
  variantOf,
} from "./config-fields";

/** Each object of a schema with the variant it stands for (null for a type with no variant). */
function objectsOf(schema: z.ZodType): Array<{ variant: string | null; keys: string[] }> {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return (schema.options as z.ZodObject[]).map((option) => {
      const variant = (option.shape.variant as z.ZodLiteral<string>).value;
      return { variant, keys: Object.keys(option.shape).filter((key) => key !== "variant") };
    });
  }
  if (schema instanceof z.ZodObject) return [{ variant: null, keys: Object.keys(schema.shape) }];
  throw new Error("unexpected schema");
}

/** A valid config for each type and variant (the defaults applied). */
const SAMPLES: Record<SourceType, unknown[]> = {
  x_user: [{ username: "chamath" }],
  x_search: [{ query: "coding agents" }],
  podcast: [{ feedUrl: "https://example.com/p.xml", show: "All-In" }],
  blog: [{ feedUrl: "https://example.com/feed" }],
  github: [{ owner: "anthropics", repo: "claude-code" }],
  docs: [{ url: "https://example.com/changelog" }],
  newsletter: [
    { variant: "feed", feedUrl: "https://example.com/feed" },
    { variant: "inbox", sender: "news@example.com" },
  ],
  youtube: [
    { variant: "channel", channelId: "UC1234567890abcdef", title: "Talks" },
    { variant: "playlist", playlistId: "PL1234567890abc", title: "Demos" },
  ],
  community: [
    { variant: "hn", query: "coding agent" },
    { variant: "reddit", subreddit: "LocalLLaMA" },
    { variant: "discourse", baseUrl: "https://forum.example.com" },
  ],
  research: [
    { variant: "arxiv_query", query: "agent evaluation" },
    { variant: "arxiv_author", author: "Ada Lovelace" },
    { variant: "openalex_institution", institutionId: "I63966007", name: "Example Lab" },
  ],
  web_search: [{ query: "agent orchestration" }],
};

describe("configFields", () => {
  it.each(SOURCE_TYPES)("has one field for each key of the %s schema", (type) => {
    for (const { variant, keys } of objectsOf(configSchemas[type] as z.ZodType)) {
      const fields = configFields(type, variant ? { variant } : {}).map((field) => field.key);
      expect(fields.sort()).toEqual([...keys].sort());
    }
  });

  it.each(SOURCE_TYPES)("passes the browser check for a valid %s config", (type) => {
    for (const sample of SAMPLES[type]) {
      const config = parseConfig(type, sample);
      expect(checkConfig(type, config)).toEqual({});
    }
  });

  it("names the variants", () => {
    expect(variantOf({ variant: "inbox" })).toBe("inbox");
    expect(variantOf({})).toBeNull();
    expect(variantLabel("newsletter", "inbox")).toBe("Emails from a sender");
    expect(variantLabel("blog", null)).toBeNull();
    expect(configFields("community", { variant: "unknown" })).toEqual([]);
  });
});

describe("checkConfig", () => {
  it("finds a missing required field, a bad address, and a number out of range", () => {
    expect(checkConfig("podcast", { feedUrl: "", show: "x", transcripts: true })).toHaveProperty("feedUrl");
    expect(checkConfig("blog", { feedUrl: "ftp://example.com", sections: [], authors: [], fullText: false })).toEqual({
      feedUrl: "Use an address that starts with http:// or https://.",
    });
    expect(checkConfig("x_search", { ...parseConfig("x_search", { query: "a" }), maxPostsPerRun: 5 })).toHaveProperty("maxPostsPerRun");
    expect(checkConfig("x_search", { ...parseConfig("x_search", { query: "a" }), keepTop: "3x" })).toHaveProperty("keepTop");
  });

  it("accepts an empty optional number", () => {
    expect(checkConfig("podcast", { feedUrl: "https://example.com/p.xml", show: "x", transcripts: true })).toEqual({});
  });
});

describe("field values", () => {
  it("turns list text into a list and back", () => {
    expect(textToList("cs.AI, cs.SE,\n cs.LG ,,")).toEqual(["cs.AI", "cs.SE", "cs.LG"]);
    expect(listToText(["a", "b"])).toBe("a, b");
    expect(listToText(undefined)).toBe("");
  });

  it("maps an empty text field by its kind", () => {
    const [optional] = configFields("docs", {}).filter((f) => f.key === "selector");
    const [nullable] = configFields("community", { variant: "hn" }).filter((f) => f.key === "query");
    const [required] = configFields("docs", {}).filter((f) => f.key === "url");
    if (optional?.kind !== "text" || nullable?.kind !== "text" || required?.kind !== "text") throw new Error("fields");
    expect(textFieldValue(optional, " ")).toBeUndefined();
    expect(textFieldValue(nullable, "")).toBeNull();
    expect(textFieldValue(required, "")).toBe("");
    expect(textFieldValue(required, "https://x.dev")).toBe("https://x.dev");
  });

  it("keeps whole numbers and the raw text of a bad number", () => {
    const [field] = configFields("podcast", {}).filter((f) => f.key === "itunesId");
    if (field?.kind !== "number") throw new Error("field");
    expect(numberFieldValue(field, "42")).toBe(42);
    expect(numberFieldValue(field, "")).toBeUndefined();
    expect(numberFieldValue(field, "4.5")).toBe("4.5");
  });

  it("removes a key for undefined", () => {
    expect(setConfigValue({ a: 1, b: 2 }, "a", undefined)).toEqual({ b: 2 });
    expect(setConfigValue({ a: 1 }, "b", null)).toEqual({ a: 1, b: null });
  });
});
