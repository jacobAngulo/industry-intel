// The names that other modules import. These tests hold for the phase 1
// stubs and for the real modules that replace them: they test the names and
// the kinds, not the behavior.
import { describe, expect, it } from "vitest";

import { getDeps, setDepsForTests } from "@/lib/deps";
import * as digests from "@/lib/digests";
import * as http from "@/lib/http";
import * as llm from "@/lib/llm";
import * as mail from "@/lib/mail";
import * as pipeline from "@/lib/pipeline";
import * as ranking from "@/lib/ranking";
import * as recompute from "@/lib/ranking/recompute";
import * as schedule from "@/lib/schedule";
import * as seed from "@/lib/seed";
import * as services from "@/lib/services";

function expectFunctions(module: Record<string, unknown>, names: string[]): void {
  for (const name of names) {
    expect(typeof module[name], `export "${name}"`).toBe("function");
  }
}

describe("module contracts", () => {
  it("the pipeline exports the functions of specification §7", () => {
    expectFunctions(pipeline, [
      "checkSource",
      "dueSourceIds",
      "claimItemsToJudge",
      "judgeItem",
      "judgeDraft",
      "runNextAnalysis",
      "runRejudgeStep",
      "housekeeping",
      "modelGate",
    ]);
    expectFunctions(digests, ["createDueDigests"]);
  });

  it("the ranking and the schedule export the functions of §8 and §9.2", () => {
    expectFunctions(ranking, ["hiddenReason", "baseScore", "effectiveHalfLife", "decayedScore"]);
    expectFunctions(recompute, ["recomputeJudgements"]);
    expectFunctions(schedule, ["previousOccurrence", "occurrenceBefore", "isQuietHours", "quietHoursEnd", "zonedParts"]);
  });

  it("the HTTP, model, mail, and seed modules export the functions of §11 and §12", () => {
    expectFunctions(http, ["createSafeHttp", "HttpError"]);
    expectFunctions(llm, ["getLlm", "getWebSearch", "FakeLlm", "LlmError"]);
    expectFunctions(mail, ["createMailReader"]);
    expectFunctions(seed, ["runSeed"]);
  });

  it("the services export each function of §18.2", () => {
    expectFunctions(services, [
      // feeds.ts
      "listFeeds",
      "getFeedBySlug",
      "createFeed",
      "updateFeedProfile",
      "updateFeedInterests",
      "updateFeedDelivery",
      "archiveFeed",
      "restoreFeed",
      "deleteFeed",
      "listFeedSources",
      "setFeedSource",
      // sources.ts
      "listSources",
      "getSource",
      "updateSource",
      "deleteSource",
      "setPaused",
      "requestCheck",
      "requestCheckAllDue",
      "flagNoisy",
      "resolveFlags",
      // add-source.ts
      "resolveEntries",
      "previewSource",
      "qualifyPreview",
      "createFromWizard",
      "listSuggestions",
      // stories.ts, feedback.ts, analyses.ts
      "listFeedStories",
      "getStory",
      "vote",
      "requestAnalysis",
      // digests.ts
      "listDigests",
      "getDigest",
      "latestDigest",
      // settings.ts
      "getTeamProfile",
      "updateTeamProfile",
      "listTopics",
      "createTopic",
      "updateTopic",
      "archiveTopic",
      "getDefaults",
      "updateDefaults",
      // rejudge.ts
      "estimateRejudge",
      "requestRejudge",
      "rejudgeProgress",
      // status.ts
      "getStatus",
      "getBanners",
      "retryFailedItems",
      // activity.ts
      "logActivity",
      "listActivity",
    ]);
  });

  it("getDeps builds the dependencies one time for each process", () => {
    setDepsForTests(null);
    try {
      const deps = getDeps();
      expect(getDeps()).toBe(deps);
      expect(typeof deps.llm.json).toBe("function");
      expect(typeof deps.http.request).toBe("function");
      expect(typeof deps.usage.take).toBe("function");
      expect(typeof deps.now()).toBe("number");
      expect(deps.env.llmMaxCallsPerDay).toBeGreaterThanOrEqual(0);
    } finally {
      setDepsForTests(null);
    }
  });
});
