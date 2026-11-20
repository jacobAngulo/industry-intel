import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOUR_MS } from "@/lib/time";
import {
  installTestDb,
  linkFeedSource,
  makeFeed,
  makeItem,
  makeJudgement,
  makeSource,
  makeStory,
  setNowForTests,
  type InstalledTestDb,
} from "@/test/helpers";

import { rejudgeEstimates } from "./estimates";

const NOW = 1_800_000_000_000;

let t: InstalledTestDb;
beforeEach(() => {
  t = installTestDb();
  setNowForTests(NOW);
});
afterEach(() => t.cleanup());

describe("rejudgeEstimates", () => {
  it("gives one estimate for each active feed, or for the given feed and source", async () => {
    const first = makeFeed({ name: "First", position: 1 });
    const second = makeFeed({ name: "Second", position: 2 });
    makeFeed({ name: "Old", position: 3, archivedAt: NOW - HOUR_MS });
    const a = makeSource();
    const b = makeSource();
    linkFeedSource(first.id, a.id);
    linkFeedSource(first.id, b.id);
    linkFeedSource(second.id, b.id);
    for (const source of [a, a, b]) {
      const story = makeStory();
      makeItem({ sourceId: source.id, storyId: story.id, fetchedAt: NOW - HOUR_MS });
      makeJudgement({ feedId: first.id, storyId: story.id, judgedAt: NOW - HOUR_MS });
    }

    const all = await rejudgeEstimates();
    expect(all.map((e) => e.feedName)).toEqual(["First", "Second"]);
    expect(all[0]).toEqual({ feedId: first.id, feedName: "First", calls: 3 });

    expect(await rejudgeEstimates({ feedIds: [first.id], sourceId: a.id })).toEqual([
      { feedId: first.id, feedName: "First", calls: 2 },
    ]);
  });
});
