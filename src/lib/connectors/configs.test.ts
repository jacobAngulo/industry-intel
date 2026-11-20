import { describe, expect, it } from "vitest";

import { createEnv } from "@/lib/env";
import { SOURCE_TYPES } from "@/lib/types";

import { IDENTITY_FIELDS, configSchemas, credentialNeeds, parseConfig, sourceKey } from "./configs";

describe("config schemas", () => {
  it("has one schema for each of the 11 types", () => {
    expect(Object.keys(configSchemas).sort()).toEqual([...SOURCE_TYPES].sort());
    expect(Object.keys(IDENTITY_FIELDS).sort()).toEqual([...SOURCE_TYPES].sort());
  });

  it("applies the defaults of the specification", () => {
    expect(parseConfig("x_user", { username: "@chamath" })).toEqual({ username: "chamath", includeReposts: false });
    expect(parseConfig("x_search", { query: "coding agents" })).toEqual({
      query: "coding agents",
      lang: "en",
      minLikes: 10,
      maxPostsPerRun: 20,
      keepTop: 3,
    });
    expect(parseConfig("podcast", { feedUrl: "https://example.com/p.xml", show: "All-In" })).toEqual({
      feedUrl: "https://example.com/p.xml",
      show: "All-In",
      transcripts: true,
    });
    expect(parseConfig("blog", { feedUrl: "https://example.com/feed" })).toEqual({
      feedUrl: "https://example.com/feed",
      sections: [],
      authors: [],
      fullText: false,
    });
    expect(parseConfig("github", { owner: "anthropics", repo: "claude-code" })).toEqual({
      owner: "anthropics",
      repo: "claude-code",
      releases: true,
      prereleases: false,
      discussions: false,
      discussionCategories: [],
      advisories: false,
    });
    expect(parseConfig("docs", { url: "https://cursor.com/changelog" })).toEqual({
      url: "https://cursor.com/changelog",
      mode: "auto",
      ignoreMinorEdits: true,
    });
    expect(parseConfig("youtube", { variant: "channel", channelId: "UCabcdefghijklmnopqrstuv", title: "Talks" })).toEqual({
      variant: "channel",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "Talks",
      includeShorts: false,
    });
    expect(parseConfig("community", { variant: "hn" })).toEqual({ variant: "hn", query: null, minPoints: 50, minComments: 0 });
    expect(parseConfig("community", { variant: "reddit", subreddit: "r/LocalLLaMA" })).toEqual({
      variant: "reddit",
      subreddit: "LocalLLaMA",
      listing: "top_day",
      minScore: 50,
    });
    expect(parseConfig("research", { variant: "arxiv_query", query: "agent evaluation" })).toEqual({
      variant: "arxiv_query",
      query: "agent evaluation",
      categories: [],
    });
    expect(parseConfig("web_search", { query: "agent evaluation" })).toEqual({
      query: "agent evaluation",
      allowedDomains: [],
      excludedDomains: [],
      maxResults: 8,
    });
  });

  it("refuses a config that is not valid", () => {
    expect(() => parseConfig("x_user", { username: "not a handle!" })).toThrow();
    expect(() => parseConfig("blog", { feedUrl: "ftp://example.com/feed" })).toThrow();
    expect(() => parseConfig("blog", { feedUrl: "javascript:alert(1)" })).toThrow();
    expect(() => parseConfig("github", { owner: "a/b", repo: "c" })).toThrow();
    expect(() => parseConfig("newsletter", { variant: "inbox", sender: "not-an-address" })).toThrow();
    expect(() => parseConfig("newsletter", { variant: "other" })).toThrow();
    expect(() => parseConfig("x_search", { query: "x", maxPostsPerRun: 5 })).toThrow();
    expect(() => parseConfig("web_search", { query: "x", allowedDomains: ["https://example.com/path"] })).toThrow();
    expect(() => parseConfig("docs", { url: "https://example.com", mode: "weekly" })).toThrow();
  });
});

describe("sourceKey", () => {
  const key = <T extends (typeof SOURCE_TYPES)[number]>(type: T, config: unknown) => sourceKey(type, parseConfig(type, config));

  it("x_user: the user name in lower case with no @", () => {
    expect(key("x_user", { username: "@Chamath" })).toBe("x_user:chamath");
    expect(key("x_user", { username: "chamath", includeReposts: true })).toBe("x_user:chamath");
  });

  it("x_search: the query in lower case with single spaces, and the language", () => {
    expect(key("x_search", { query: "  Coding   Agents " })).toBe("x_search:coding agents|en");
    expect(key("x_search", { query: "coding agents", lang: "DE" })).toBe("x_search:coding agents|de");
  });

  it("podcast and blog: the normalized feed address", () => {
    expect(key("podcast", { feedUrl: "HTTPS://RSS.Example.com/Shows/1.xml#top", show: "A" })).toBe(
      "podcast:https://rss.example.com/Shows/1.xml",
    );
    expect(key("blog", { feedUrl: "https://GitHub.blog/changelog/label/copilot/feed/" })).toBe(
      "blog:https://github.blog/changelog/label/copilot/feed",
    );
    expect(key("blog", { feedUrl: "https://example.com/feed?format=rss" })).toBe("blog:https://example.com/feed?format=rss");
    expect(key("blog", { feedUrl: "https://example.com/" })).toBe("blog:https://example.com");
    // http stays http: it is a different address.
    expect(key("blog", { feedUrl: "http://example.com/feed" })).toBe("blog:http://example.com/feed");
  });

  it("github: owner/repo in lower case", () => {
    expect(key("github", { owner: "Anthropics", repo: "Claude-Code" })).toBe("github:anthropics/claude-code");
  });

  it("docs: the normalized page address", () => {
    expect(key("docs", { url: "https://Learn.Microsoft.com/en-us/azure/foundry/whats-new-foundry/#november" })).toBe(
      "docs:https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry",
    );
  });

  it("newsletter: feed and inbox variants", () => {
    expect(key("newsletter", { variant: "feed", feedUrl: "https://News.example.com/feed/" })).toBe(
      "newsletter:feed:https://news.example.com/feed",
    );
    expect(key("newsletter", { variant: "inbox", sender: "News@Example.com" })).toBe("newsletter:inbox:news@example.com|");
    expect(key("newsletter", { variant: "inbox", sender: "news@example.com", subjectIncludes: "Weekly" })).toBe(
      "newsletter:inbox:news@example.com|Weekly",
    );
  });

  it("youtube: channel and playlist variants", () => {
    expect(key("youtube", { variant: "channel", channelId: "UCabcdefghijklmnopqrstuv", title: "T" })).toBe(
      "youtube:channel:UCabcdefghijklmnopqrstuv",
    );
    expect(key("youtube", { variant: "playlist", playlistId: "PLabcdefghijklmnop", title: "T" })).toBe(
      "youtube:playlist:PLabcdefghijklmnop",
    );
  });

  it("community: hn, reddit, and discourse variants", () => {
    expect(key("community", { variant: "hn", query: "Coding Agent", minPoints: 100 })).toBe("community:hn:coding agent|100");
    expect(key("community", { variant: "hn" })).toBe("community:hn:front_page|50");
    expect(key("community", { variant: "reddit", subreddit: "LocalLLaMA", listing: "hot" })).toBe(
      "community:reddit:localllama|hot",
    );
    expect(key("community", { variant: "discourse", baseUrl: "https://Forum.example.com/" })).toBe(
      "community:discourse:https://forum.example.com||",
    );
    expect(
      key("community", { variant: "discourse", baseUrl: "https://forum.example.com", categorySlug: "agents", categoryId: 7, tag: "eval" }),
    ).toBe("community:discourse:https://forum.example.com|agents|eval");
  });

  it("research: the three variants", () => {
    expect(key("research", { variant: "arxiv_query", query: "Agent Evaluation", categories: ["cs.LG", "cs.AI"] })).toBe(
      "research:arxiv_query:agent evaluation|cs.ai,cs.lg",
    );
    expect(key("research", { variant: "arxiv_query", query: "agent evaluation" })).toBe("research:arxiv_query:agent evaluation|");
    expect(key("research", { variant: "arxiv_author", author: "Jane Q. Doe" })).toBe("research:arxiv_author:jane q. doe");
    expect(key("research", { variant: "openalex_institution", institutionId: "I63966007", name: "MIT" })).toBe(
      "research:openalex:I63966007",
    );
  });

  it("web_search: the query in lower case and the sorted allowed domains", () => {
    expect(key("web_search", { query: "Agent Evaluation", allowedDomains: ["openai.com", "Anthropic.com"] })).toBe(
      "web_search:agent evaluation|anthropic.com,openai.com",
    );
    expect(key("web_search", { query: "agent evaluation", excludedDomains: ["example.com"] })).toBe(
      "web_search:agent evaluation|",
    );
  });

  it("gives the same key for the same identity with different options", () => {
    expect(key("github", { owner: "openai", repo: "codex", prereleases: true })).toBe(
      key("github", { owner: "OpenAI", repo: "Codex", advisories: true }),
    );
  });
});

describe("credentialNeeds", () => {
  const empty = createEnv({});

  it("x_user and x_search need the X token", () => {
    expect(credentialNeeds("x_user", empty)?.code).toBe("x_token");
    expect(credentialNeeds("x_search", empty)?.code).toBe("x_token");
    const env = createEnv({ X_BEARER_TOKEN: "test-token" });
    expect(credentialNeeds("x_user", env)).toBeNull();
    expect(credentialNeeds("x_search", env)).toBeNull();
  });

  it("only the inbox variant of the newsletter needs the mailbox", () => {
    expect(credentialNeeds("newsletter", empty)).toBeNull();
    expect(credentialNeeds("newsletter", empty, { variant: "feed", feedUrl: "https://example.com/feed" })).toBeNull();
    const need = credentialNeeds("newsletter", empty, { variant: "inbox", sender: "news@example.com" });
    expect(need?.code).toBe("mailbox");
    expect(need?.message).toContain("IMAP_HOST");
    const env = createEnv({ IMAP_HOST: "imap.example.test", IMAP_USER: "u", IMAP_PASSWORD: "p" });
    expect(credentialNeeds("newsletter", env, { variant: "inbox", sender: "news@example.com" })).toBeNull();
  });

  it("web_search needs the model key, and the other types need nothing", () => {
    expect(credentialNeeds("web_search", empty)?.code).toBe("model_key");
    expect(credentialNeeds("web_search", createEnv({ OLLAMA_API_KEY: "test-key" }))).toBeNull();
    for (const type of ["podcast", "blog", "github", "docs", "youtube", "community", "research"] as const) {
      expect(credentialNeeds(type, empty)).toBeNull();
    }
  });
});
