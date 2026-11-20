import { describe, expect, it } from "vitest";

import {
  aboutInput,
  commonInput,
  configInput,
  createInput,
  feedLinkInput,
  flagInput,
  pausedInput,
  previewInput,
  qualifyInput,
  rejudgeInput,
  resolveInput,
  sourceIdInput,
} from "./schemas";

const common = {
  why: "Directly affects our internal AI app.",
  feedIds: [1, 2],
  follow: "agents, permissions",
  ignore: "",
  priority: "high" as const,
  checkIntervalMinutes: 360,
  owner: "Dana",
};

describe("source page schemas", () => {
  it("accepts an id and refuses other values", () => {
    expect(sourceIdInput.safeParse({ id: 3 }).success).toBe(true);
    expect(sourceIdInput.safeParse({ id: 0 }).success).toBe(false);
    expect(sourceIdInput.safeParse({ id: "3" }).success).toBe(false);
    expect(pausedInput.safeParse({ id: 3, paused: "yes" }).success).toBe(false);
  });

  it("checks the about fields and turns an empty owner into null", () => {
    const parsed = aboutInput.parse({ id: 1, name: "  Foundry  ", why: "Affects us.", owner: "  ", checkIntervalMinutes: 60 });
    expect(parsed).toEqual({ id: 1, name: "Foundry", why: "Affects us.", owner: null, checkIntervalMinutes: 60 });
    const bad = aboutInput.safeParse({ id: 1, name: "", why: "", owner: null, checkIntervalMinutes: 2 });
    expect(bad.success).toBe(false);
    const paths = bad.error?.issues.map((issue) => issue.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["name", "why", "checkIntervalMinutes"]));
    expect(aboutInput.safeParse({ id: 1, name: "x".repeat(121), why: "a", owner: null, checkIntervalMinutes: 60 }).success).toBe(false);
  });

  it("takes only the about fields that changed", () => {
    expect(aboutInput.parse({ id: 1, checkIntervalMinutes: 120 })).toEqual({ id: 1, checkIntervalMinutes: 120 });
    expect(aboutInput.parse({ id: 1, owner: "" })).toEqual({ id: 1, owner: null });
    expect(aboutInput.safeParse({ id: 1 }).success).toBe(false);
    expect(aboutInput.safeParse({ id: 1, name: " " }).success).toBe(false);
  });

  it("takes a config object only", () => {
    expect(configInput.safeParse({ id: 1, config: { feedUrl: "https://x" } }).success).toBe(true);
    expect(configInput.safeParse({ id: 1, config: "text" }).success).toBe(false);
  });

  it("caps Follow and Ignore at 300 characters", () => {
    const base = { sourceId: 1, feedId: 2, included: true, priority: "normal", follow: "", ignore: "" };
    expect(feedLinkInput.safeParse(base).success).toBe(true);
    expect(feedLinkInput.safeParse({ ...base, follow: "x".repeat(301) }).success).toBe(false);
    expect(feedLinkInput.safeParse({ ...base, priority: "urgent" }).success).toBe(false);
    expect(rejudgeInput.safeParse({ sourceId: 1, feedId: 2 }).success).toBe(true);
  });

  it("allows an empty noisy note", () => {
    expect(flagInput.parse({ id: 1, note: "  " })).toEqual({ id: 1, note: "" });
    expect(flagInput.safeParse({ id: 1, note: "x".repeat(301) }).success).toBe(false);
  });
});

describe("add-source schemas", () => {
  it("resolve: 1 to 10 entries after the empty ones go", () => {
    expect(resolveInput.parse({ entries: [" @a ", "", "b"], type: "x_user" })).toEqual({ entries: ["@a", "b"], type: "x_user" });
    expect(resolveInput.safeParse({ entries: ["", " "] }).success).toBe(false);
    expect(resolveInput.safeParse({ entries: Array.from({ length: 11 }, (_, i) => `@u${i}`) }).success).toBe(false);
    expect(resolveInput.safeParse({ entries: ["x".repeat(2001)] }).success).toBe(false);
    expect(resolveInput.safeParse({ entries: ["a"], type: "rss" }).success).toBe(false);
    expect(resolveInput.safeParse({ entries: ["a"], type: null }).success).toBe(true);
  });

  it("common: why is required, the owner can be empty, the interval is 5 min to a week", () => {
    expect(commonInput.parse({ ...common, owner: "" }).owner).toBeNull();
    expect(commonInput.safeParse({ ...common, why: " " }).success).toBe(false);
    expect(commonInput.safeParse({ ...common, checkIntervalMinutes: 20_000 }).success).toBe(false);
    expect(commonInput.safeParse({ ...common, feedIds: [0] }).success).toBe(false);
  });

  it("preview and create: at least one entry with a type and a name", () => {
    const entry = { type: "podcast", name: "All-In", config: { feedUrl: "https://example.com/p.xml", show: "All-In" } };
    expect(previewInput.safeParse({ entries: [entry], common }).success).toBe(true);
    expect(createInput.safeParse({ entries: [entry], common }).success).toBe(true);
    expect(createInput.safeParse({ entries: [], common }).success).toBe(false);
    expect(createInput.safeParse({ entries: [{ ...entry, name: "" }], common }).success).toBe(false);
    expect(createInput.safeParse({ entries: [{ ...entry, type: "rss" }], common }).success).toBe(false);
    const issues = createInput.safeParse({ entries: [{ ...entry, name: "" }], common: { ...common, why: "" } }).error?.issues ?? [];
    expect(issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["entries.0.name", "common.why"]));
  });

  it("qualify: the items of the preview", () => {
    const input = {
      type: "x_user",
      sourceName: "@chamath",
      items: [{ externalId: "1", title: "A post", url: null, publishedAt: 1, excerpt: "text" }],
      config: { username: "chamath" },
      feedIds: [3],
      follow: "",
      ignore: "",
      priority: "normal",
    };
    expect(qualifyInput.safeParse(input).success).toBe(true);
    expect(qualifyInput.safeParse({ ...input, items: [{ ...input.items[0], excerpt: "x".repeat(4001) }] }).success).toBe(false);
  });
});
