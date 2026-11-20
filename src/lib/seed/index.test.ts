import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { feedSources, feedTopics, feeds, settings, sources, topics } from "@/lib/db/schema";
import { getDefaults, getFeedBySlug, getTeamProfile, listSuggestions, listTopics } from "@/lib/services";
import { serverTimeZone } from "@/lib/types";
import { installTestDb, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { runSeed } from "./index";

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(1_800_000_000_000);
});
afterEach(() => t.cleanup());

function settingValue(key: string): unknown {
  return t.db.select().from(settings).all().find((row) => row.key === key)?.value;
}

describe("runSeed (§12)", () => {
  it("returns true and writes the seeded_at row", () => {
    expect(runSeed(t.db)).toBe(true);
    expect(settingValue("seeded_at")).toBe(1_800_000_000_000);
  });

  it("writes the shared feed profile with only the owner's words", async () => {
    runSeed(t.db);
    expect(await getTeamProfile()).toEqual({
      whatWeDo:
        "Software engineering with agentic development: projects for internal teams, and an in-house AI app for the organization.",
      constraints: "",
    });
  });

  it("writes the shared defaults", async () => {
    runSeed(t.db);
    const defaults = await getDefaults();
    expect(defaults.briefDefaults).toEqual({ summaryLength: "standard", technicalDepth: "practitioner", suggestedActions: true });
    expect(defaults.defaultExclusions).toEqual(["Politics", "Funding announcements", "Beginner tutorials", "Repeated launch coverage"]);
    expect(defaults.feedDefaults).toEqual({
      minRelevance: 60,
      halfLifeHours: 48,
      digest: { frequency: "weekdays", weekday: 1, time: "08:30", timeZone: serverTimeZone(), maxStories: 10 },
      quietHours: { enabled: false, start: "18:00", end: "08:00" },
      alerts: { enabled: false, rule: "", minRelevance: 85 },
    });
  });

  it("writes the 10 topics, each with a one-line description", async () => {
    runSeed(t.db);
    const list = await listTopics();
    expect(list.map((topic) => topic.name)).toEqual([
      "Coding agents",
      "Agent workflows",
      "Testing and evaluations",
      "Document processing",
      "Microsoft Foundry",
      "Permissions and data access",
      "Orchestration",
      "Enterprise deployment",
      "Model releases",
      "Company announcements",
    ]);
    for (const topic of list) {
      expect(topic.description.length).toBeGreaterThan(10);
      expect(topic.description).not.toContain("\n");
      expect(topic.archived).toBe(false);
    }
    expect(list[0]?.slug).toBe("coding-agents");
  });

  it("writes the 3 feeds with their topics, priorities, half-life, depth, and alert rules (alerts off)", async () => {
    runSeed(t.db);
    const topicId = (name: string) => t.db.select().from(topics).all().find((row) => row.name === name)!.id;
    const highTopics = (feedId: number) =>
      t.db
        .select()
        .from(feedTopics)
        .all()
        .filter((row) => row.feedId === feedId)
        .map((row) => [row.topicId, row.priority]);

    const agentic = (await getFeedBySlug("agentic-development"))!;
    expect(agentic).toMatchObject({
      name: "Agentic Development",
      purpose: "Coding agents, agent workflows, testing, and evaluations for projects built with agents.",
      position: 1,
      minRelevance: 60,
      halfLifeHours: 48,
      exclusions: ["Politics", "Funding announcements", "Beginner tutorials", "Repeated launch coverage"],
      relevancePriorities: { practical: "strong", experiment: "normal", other: "" },
      briefFormat: { summaryLength: null, technicalDepth: null, suggestedActions: null },
      effectiveBriefFormat: { technicalDepth: "practitioner" },
      alerts: {
        enabled: false,
        minRelevance: 85,
        rule: "A security problem or a breaking change in a coding agent or an agent tool that this feed follows; a major release of a coding agent.",
      },
      digest: { frequency: "weekdays", time: "08:30", maxStories: 10 },
      quietHours: { enabled: false },
    });
    expect(highTopics(agentic.id)).toEqual(
      ["Coding agents", "Agent workflows", "Testing and evaluations"].map((name) => [topicId(name), "high"]),
    );

    const platform = (await getFeedBySlug("internal-ai-platform"))!;
    expect(platform).toMatchObject({
      name: "Internal AI Platform",
      purpose: "Foundry, permissions, data access, and orchestration for the in-house AI app.",
      position: 2,
      halfLifeHours: 48,
      relevancePriorities: { practical: "normal", experiment: "normal" },
      effectiveBriefFormat: { technicalDepth: "practitioner" },
      alerts: {
        enabled: false,
        rule: "A deprecation, a breaking change, or a security notice that affects Microsoft Foundry or the way teams get access to data.",
      },
    });
    expect(highTopics(platform.id)).toEqual(
      ["Microsoft Foundry", "Permissions and data access", "Orchestration", "Enterprise deployment"].map((name) => [topicId(name), "high"]),
    );

    const radar = (await getFeedBySlug("industry-radar"))!;
    expect(radar).toMatchObject({
      name: "Industry Radar",
      purpose: "Broader developments from podcasts, X, and company announcements that can change the direction of the tracked projects.",
      position: 3,
      halfLifeHours: 36,
      minRelevance: 50, // a radar shows "worth knowing" stories (band 50-69)
      relevancePriorities: { practical: "normal", experiment: "normal" },
      briefFormat: { technicalDepth: "overview" },
      effectiveBriefFormat: { technicalDepth: "overview", summaryLength: "standard" },
      alerts: { enabled: false, rule: "" },
    });
    expect(highTopics(radar.id)).toEqual(["Model releases", "Company announcements"].map((name) => [topicId(name), "high"]));
  });

  it("writes the 3 sources with their feed links and Follow / Ignore text", () => {
    runSeed(t.db);
    const feedIdOf = (slug: string) => t.db.select().from(feeds).all().find((row) => row.slug === slug)!.id;
    const rows = t.db.select().from(sources).all();
    expect(rows.map((row) => [row.type, row.name, row.key, row.addedBy])).toEqual([
      ["x_user", "@chamath", "x_user:chamath", "Starter set"],
      ["podcast", "All-In", "podcast:https://rss.libsyn.com/shows/254861/destinations/1928300.xml", "Starter set"],
      ["docs", "Microsoft Foundry: What's new", "docs:https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry", "Starter set"],
    ]);
    expect(rows[0]).toMatchObject({
      config: { username: "chamath", includeReposts: false },
      why: "A first X account of the starter set.",
      checkIntervalMinutes: 60,
      paused: false,
      checkRequestedAt: null,
    });
    expect(rows[1]).toMatchObject({
      config: {
        feedUrl: "https://rss.libsyn.com/shows/254861/destinations/1928300.xml",
        show: "All-In with Chamath, Jason, Sacks & Friedberg",
        itunesId: 1502871393,
        transcripts: true,
      },
      why: "The first podcast of the starter set.",
      checkIntervalMinutes: 180,
    });
    expect(rows[2]).toMatchObject({
      config: { url: "https://learn.microsoft.com/en-us/azure/foundry/whats-new-foundry", mode: "auto", ignoreMinorEdits: true },
      why: "Directly affects the internal AI app.",
      checkIntervalMinutes: 360,
    });

    const links = t.db.select().from(feedSources).all();
    expect(links.map((link) => [link.feedId, link.sourceId, link.priority, link.follow, link.ignore])).toEqual([
      [feedIdOf("industry-radar"), rows[0]!.id, "normal", "", ""],
      [feedIdOf("industry-radar"), rows[1]!.id, "normal", "", ""],
      [
        feedIdOf("internal-ai-platform"),
        rows[2]!.id,
        "high",
        "agents, permissions, private networking",
        "cosmetic documentation edits",
      ],
    ]);
  });

  it("a second call does not duplicate anything", () => {
    runSeed(t.db);
    const count = () => ({
      feeds: t.db.select().from(feeds).all().length,
      topics: t.db.select().from(topics).all().length,
      sources: t.db.select().from(sources).all().length,
      links: t.db.select().from(feedSources).all().length,
      feedTopics: t.db.select().from(feedTopics).all().length,
      settings: t.db.select().from(settings).all().length,
    });
    const first = count();
    expect(first).toEqual({ feeds: 3, topics: 10, sources: 3, links: 3, feedTopics: 9, settings: 5 });
    expect(runSeed(t.db)).toBe(true);
    expect(count()).toEqual(first);
  });

  it("does not replace rows that a person changed when seeded_at is absent", async () => {
    runSeed(t.db);
    t.sqlite.prepare("DELETE FROM settings WHERE key = 'seeded_at'").run();
    t.sqlite.prepare("UPDATE feeds SET name = 'Renamed' WHERE slug = 'industry-radar'").run();
    runSeed(t.db);
    expect((await getFeedBySlug("industry-radar"))?.name).toBe("Renamed");
    expect(t.db.select().from(feeds).all()).toHaveLength(3);
  });

  it("the suggestions of the seeded sources do not show; the others do", async () => {
    runSeed(t.db);
    expect((await listSuggestions()).length).toBe(11);
    expect((await listSuggestions("internal-ai-platform")).map((s) => s.name)).toEqual([
      "Microsoft Foundry blog",
      "Model Context Protocol releases",
    ]);
  });
});
