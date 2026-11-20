import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig, sourceKey } from "@/lib/connectors/configs";
import { getConnector } from "@/lib/connectors/registry";
import { listSuggestions } from "@/lib/services/add-source";
import { installTestDb, makeSource, type InstalledTestDb } from "@/test/helpers";

import { STARTER_SUGGESTIONS, SUGGESTION_FEED_SLUGS } from "./suggestions";

describe("starter suggestions", () => {
  it("has the 11 suggestions of the specification for the 3 feeds", () => {
    expect(STARTER_SUGGESTIONS).toHaveLength(11);
    const byFeed = (slug: string) => STARTER_SUGGESTIONS.filter((s) => s.feedSlug === slug).length;
    expect(byFeed(SUGGESTION_FEED_SLUGS.agenticDevelopment)).toBe(7);
    expect(byFeed(SUGGESTION_FEED_SLUGS.internalAiPlatform)).toBe(2);
    expect(byFeed(SUGGESTION_FEED_SLUGS.industryRadar)).toBe(2);
  });

  it("each config passes the configSchema of its type", () => {
    for (const suggestion of STARTER_SUGGESTIONS) {
      const result = getConnector(suggestion.type).configSchema.safeParse(suggestion.config);
      expect(result.success, `${suggestion.name}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
    const hn = STARTER_SUGGESTIONS.find((s) => s.type === "community");
    expect(parseConfig("community", hn?.config)).toEqual({ variant: "hn", query: "coding agent", minPoints: 100, minComments: 0 });
  });

  it("each suggestion has a name, a plain one-line why, a human link, and its own key", () => {
    const keys = new Set<string>();
    for (const suggestion of STARTER_SUGGESTIONS) {
      expect(suggestion.name.length).toBeGreaterThan(3);
      expect(suggestion.why).toMatch(/^[A-Z].{15,160}\.$/);
      expect(suggestion.why).not.toContain("\n");
      expect(suggestion.url).toMatch(/^https:\/\//);
      keys.add(sourceKey(suggestion.type, parseConfig(suggestion.type, suggestion.config)));
    }
    expect(keys.size).toBe(STARTER_SUGGESTIONS.length);
    expect(keys.has("github:anthropics/claude-code")).toBe(true);
    expect(keys.has("blog:https://openai.com/news/rss.xml")).toBe(true);
  });
});

describe("with a database", () => {
  let t: InstalledTestDb;
  beforeEach(() => {
    t = installTestDb();
  });
  afterEach(() => t.cleanup());

  it("listSuggestions leaves out the suggestions that are in the directory", async () => {
    expect(await listSuggestions()).toHaveLength(11);
    expect(await listSuggestions(SUGGESTION_FEED_SLUGS.industryRadar)).toHaveLength(2);

    makeSource({ type: "github", config: { owner: "Anthropics", repo: "Claude-Code" } });
    const left = await listSuggestions(SUGGESTION_FEED_SLUGS.agenticDevelopment);
    expect(left).toHaveLength(6);
    expect(left.map((s) => s.name)).not.toContain("Claude Code releases");
  });
});
