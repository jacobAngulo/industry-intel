import { afterEach, describe, expect, it, vi } from "vitest";

import { createEnv } from "@/lib/env";
import { SOURCE_TYPES, SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";
import { makeConnectorContext } from "@/test/helpers";

import { parseConfig, sourceKey } from "./configs";
import { connectors, getConnector, resolveInput } from "./registry";
import type { Candidate } from "./types";

afterEach(() => vi.restoreAllMocks());

const candidate = (type: Candidate["type"], name: string, confidence: number): Candidate => ({
  type,
  name,
  description: name,
  config: {},
  confidence,
});

describe("connector registry", () => {
  it("has the 11 connectors with the label, the interval, and the maximum age of the specification", () => {
    expect(Object.keys(connectors).sort()).toEqual([...SOURCE_TYPES].sort());
    for (const type of SOURCE_TYPES) {
      const connector = getConnector(type);
      expect(connector.type).toBe(type);
      expect(connector.label).toBe(SOURCE_TYPE_LABELS[type]);
      expect(connector.description.length).toBeGreaterThan(10);
      expect(connector.defaultIntervalMinutes).toBe(SOURCE_TYPE_DEFAULTS[type].intervalMinutes);
      expect(connector.maxAgeDays).toBe(SOURCE_TYPE_DEFAULTS[type].maxAgeDays);
    }
    expect(() => getConnector("nope" as never)).toThrow(/unknown source type/);
  });

  it("each connector uses the shared config schema, the shared key, and the real needs rule", () => {
    const empty = createEnv({});
    const github = getConnector("github");
    const config = github.configSchema.parse({ owner: "Anthropics", repo: "claude-code" });
    expect(github.keyOf(config)).toBe("github:anthropics/claude-code");
    expect(github.keyOf(config)).toBe(sourceKey("github", parseConfig("github", config)));
    expect(github.needs(empty, config)).toBeNull();

    expect(getConnector("x_user").needs(empty)?.code).toBe("x_token");
    expect(getConnector("x_search").needs(empty)?.code).toBe("x_token");
    expect(getConnector("web_search").needs(empty)?.code).toBe("model_key");
    expect(getConnector("newsletter").needs(empty, { variant: "inbox", sender: "a@example.com" })?.code).toBe("mailbox");
    expect(getConnector("newsletter").needs(empty, { variant: "feed", feedUrl: "https://example.com/f" })).toBeNull();
  });
});

describe("resolveInput", () => {
  it("merges the candidates of all connectors and sorts them by confidence", async () => {
    vi.spyOn(connectors.blog, "resolve").mockResolvedValue([candidate("blog", "Blog", 0.9)]);
    vi.spyOn(connectors.docs, "resolve").mockResolvedValue([candidate("docs", "Docs", 0.4)]);
    vi.spyOn(connectors.github, "resolve").mockResolvedValue([candidate("github", "Repo", 0.95)]);
    const xUser = vi.spyOn(connectors.x_user, "resolve").mockResolvedValue([]);

    const found = await resolveInput("  https://example.com  ", makeConnectorContext());
    expect(found.map((c) => c.name)).toEqual(["Repo", "Blog", "Docs"]);
    // Each connector got the trimmed entry and forced = false.
    expect(xUser).toHaveBeenCalledWith("https://example.com", expect.anything(), false);
  });

  it("runs only the forced connector, with forced = true", async () => {
    const blog = vi.spyOn(connectors.blog, "resolve").mockResolvedValue([candidate("blog", "Blog", 0.9)]);
    const search = vi.spyOn(connectors.x_search, "resolve").mockResolvedValue([candidate("x_search", "Keyword", 0.5)]);

    const found = await resolveInput("coding agents", makeConnectorContext(), "x_search");
    expect(found.map((c) => c.name)).toEqual(["Keyword"]);
    expect(search).toHaveBeenCalledWith("coding agents", expect.anything(), true);
    expect(blog).not.toHaveBeenCalled();
  });

  it("continues when one connector fails or is too slow", async () => {
    // The real connectors return low-confidence candidates for plain text.
    // Silence all of them, then script the three connectors of this test.
    for (const connector of Object.values(connectors)) {
      vi.spyOn(connector, "resolve").mockResolvedValue([]);
    }
    vi.spyOn(connectors.blog, "resolve").mockRejectedValue(new Error("boom"));
    let slowSignal: AbortSignal | undefined;
    vi.spyOn(connectors.podcast, "resolve").mockImplementation((_input, ctx) => {
      slowSignal = ctx.signal;
      return new Promise(() => {});
    });
    vi.spyOn(connectors.github, "resolve").mockResolvedValue([candidate("github", "Repo", 0.7)]);

    const found = await resolveInput("something", makeConnectorContext(), undefined, { timeoutMs: 30 });
    expect(found.map((c) => c.name)).toEqual(["Repo"]);
    // The slow connector got the stop signal at the time limit.
    expect(slowSignal?.aborted).toBe(true);
  });

  it("returns [] for an empty entry", async () => {
    expect(await resolveInput("   ", makeConnectorContext())).toEqual([]);
  });
});
