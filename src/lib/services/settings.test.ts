import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activity, judgements, settings, topics } from "@/lib/db/schema";
import { DAY_MS } from "@/lib/time";
import { defaultFeedDefaults } from "@/lib/types";
import {
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeStory,
  makeTopic,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { ServiceError } from "./_manage-errors";
import {
  archiveTopic,
  createTopic,
  getDefaults,
  getTeamProfile,
  listTopics,
  updateDefaults,
  updateTeamProfile,
  updateTopic,
} from "./settings";

const NOW = 1_800_000_000_000;
const actor = { name: "Dana", clientId: "c1" };

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

async function expectCode(promise: Promise<unknown>, code: ServiceError["code"]): Promise<ServiceError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

const actions = () => t.db.select().from(activity).all().map((row) => row.action);
const judgementOf = (id: number) => t.db.select().from(judgements).all().find((row) => row.id === id)!;

/** A visible judgement in a new feed, with one item of a source of the feed. */
function judgedStory(feedOverrides: Parameters<typeof makeFeed>[0] = {}, judgementOverrides: Partial<Parameters<typeof makeJudgement>[0]> = {}) {
  const feed = makeFeed(feedOverrides);
  const source = makeSource();
  linkFeedSource(feed.id, source.id);
  const story = makeStory();
  makeItem({ sourceId: source.id, storyId: story.id });
  const judgement = makeJudgement({ feedId: feed.id, storyId: story.id, ...judgementOverrides });
  return { feed, judgement };
}

describe("shared feed profile", () => {
  it("reads empty fields when nothing is stored, and a broken field as empty", async () => {
    expect(await getTeamProfile()).toEqual({ whatWeDo: "", constraints: "" });
    t.db.insert(settings).values({ key: "team_profile", value: { whatWeDo: "We build.", constraints: 42 }, updatedAt: NOW }).run();
    expect(await getTeamProfile()).toEqual({ whatWeDo: "We build.", constraints: "" });
  });

  it("updates the profile with validation and an activity row", async () => {
    const profile = { whatWeDo: " We build. ", constraints: "EU only" };
    await updateTeamProfile(profile, actor);
    expect(await getTeamProfile()).toEqual({ ...profile, whatWeDo: "We build." });
    expect(t.db.select().from(settings).get()).toMatchObject({ key: "team_profile", updatedBy: "Dana", updatedAt: NOW });
    expect(actions()).toEqual(["settings.team_profile"]);
    await expectCode(updateTeamProfile({ ...profile, constraints: "x".repeat(4001) }, actor), "validation");
    await expectCode(updateTeamProfile(profile, { name: "Someone", clientId: "c" }), "needs_name");
  });
});

describe("topics", () => {
  it("creates topics with a unique slug and a unique name", async () => {
    const first = await createTopic({ name: "Coding agents", description: "Agents that code." }, actor);
    expect(first).toMatchObject({ slug: "coding-agents", name: "Coding agents", description: "Agents that code.", archived: false });
    await expectCode(createTopic({ name: "coding AGENTS", description: "" }, actor), "conflict");
    const second = await createTopic({ name: "Coding agents!", description: "" }, actor);
    expect(second.slug).toBe("coding-agents-2");
    await expectCode(createTopic({ name: "", description: "" }, actor), "validation");
    expect(actions()).toEqual(["topic.create", "topic.create"]);
  });

  it("lists active topics in creation order; archived ones on request", async () => {
    const a = makeTopic({ name: "B topic" });
    const b = makeTopic({ name: "A topic", archivedAt: NOW });
    expect((await listTopics()).map((topic) => topic.id)).toEqual([a.id]);
    expect((await listTopics({ includeArchived: true })).map((topic) => [topic.id, topic.archived])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
  });

  it("updates a topic; the slug stays; a new name renews the labels of the rank parts", async () => {
    const topic = makeTopic({ name: "Agents" });
    makeTopic({ name: "Taken" });
    const { feed, judgement } = judgedStory({}, { topicIds: [topic.id] });
    t.sqlite.prepare("INSERT INTO feed_topics (feed_id, topic_id, priority) VALUES (?, ?, 'high')").run(feed.id, topic.id);

    await updateTopic(topic.id, { name: "Coding agents", description: "New text." }, actor);
    expect(t.db.select().from(topics).get()).toMatchObject({ name: "Coding agents", description: "New text.", slug: topic.slug });
    expect(judgementOf(judgement.id).rankParts.find((part) => part.key === "topic")?.label).toContain("Coding agents");

    await expectCode(updateTopic(topic.id, { name: "taken", description: "" }, actor), "conflict");
    await expectCode(updateTopic(999, { name: "X", description: "" }, actor), "not_found");
    expect(actions()).toEqual(["topic.update"]);
  });

  it("archiving a topic recomputes the rank: a muted topic no longer hides a story", async () => {
    const topic = makeTopic();
    const { feed, judgement } = judgedStory({}, { topicIds: [topic.id], hiddenReason: "muted_topic" });
    t.sqlite.prepare("INSERT INTO feed_topics (feed_id, topic_id, priority) VALUES (?, ?, 'muted')").run(feed.id, topic.id);

    await archiveTopic(topic.id, actor);
    expect((await listTopics({ includeArchived: true }))[0]?.archived).toBe(true);
    expect(judgementOf(judgement.id).hiddenReason).toBeNull();
    await archiveTopic(topic.id, actor); // a second archive changes nothing
    expect(actions()).toEqual(["topic.archive"]);
  });
});

describe("defaults", () => {
  it("reads the built-in defaults when nothing is stored", async () => {
    const defaults = await getDefaults();
    expect(defaults.briefDefaults).toEqual({ summaryLength: "standard", technicalDepth: "practitioner", suggestedActions: true });
    expect(defaults.defaultExclusions).toEqual(["Politics", "Funding announcements", "Beginner tutorials", "Repeated launch coverage"]);
    expect(defaults.feedDefaults.minRelevance).toBe(60);
  });

  it("writes the three settings rows and validates them", async () => {
    const input = {
      briefDefaults: { summaryLength: "short" as const, technicalDepth: "practitioner" as const, suggestedActions: false },
      defaultExclusions: ["Politics", "politics", "Crypto"],
      feedDefaults: { ...defaultFeedDefaults("Asia/Tokyo"), halfLifeHours: 12 },
    };
    await updateDefaults(input, actor);
    expect(await getDefaults()).toEqual({ ...input, defaultExclusions: ["Politics", "Crypto"] });
    expect(actions()).toEqual(["settings.defaults"]);

    const badZone = { ...input, feedDefaults: { ...input.feedDefaults, digest: { ...input.feedDefaults.digest, timeZone: "Nowhere/City" } } };
    const error = await expectCode(updateDefaults(badZone, actor), "validation");
    expect(error.fieldErrors).toHaveProperty("feedDefaults.digest.timeZone");
  });

  it("a new default technical depth recomputes only the feeds that use the default", async () => {
    const onDefault = judgedStory({}, { depth: "basic" });
    const ownDepth = judgedStory({ briefFormat: { summaryLength: null, technicalDepth: "practitioner", suggestedActions: null } }, { depth: "basic" });
    const old = judgedStory({}, { depth: "basic", createdAt: NOW - 40 * DAY_MS });
    t.sqlite.prepare("UPDATE stories SET fresh_at = ? WHERE id = ?").run(NOW - 40 * DAY_MS, old.judgement.storyId);
    t.db.update(judgements).set({ baseScore: 999 }).run();

    const base = await getDefaults();
    await updateDefaults({ ...base, defaultExclusions: ["A"] }, actor);
    expect(judgementOf(onDefault.judgement.id).baseScore).toBe(999);

    await updateDefaults({ ...base, briefDefaults: { ...base.briefDefaults, technicalDepth: "deep" } }, actor);
    expect(judgementOf(onDefault.judgement.id).rankParts.find((part) => part.key === "depth")?.value).toBe(-12);
    expect(judgementOf(ownDepth.judgement.id).baseScore).toBe(999);
    expect(judgementOf(old.judgement.id).baseScore).toBe(999);
  });
});
