import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LlmError } from "@/lib/llm/types";
import { MINUTE_MS } from "@/lib/time";
import { installTestDb, setNowForTests, type InstalledTestDb } from "@/test/helpers";

import { readLlmPause } from "./jobs";
import { noteModelSuccess, pauseForServiceError, pauseForTimeout } from "./model-errors";

const T = Date.UTC(2026, 10, 20, 12, 0, 0);
let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
  setNowForTests(T);
});

afterEach(() => {
  t.cleanup();
});

describe("noteModelSuccess", () => {
  it("keeps a pause that is still active, and clears an expired pause", () => {
    pauseForServiceError(new LlmError("rate_limited", "429"), T);
    noteModelSuccess(T + 2000);
    expect(readLlmPause()).toEqual({ pausedUntil: T + 10 * MINUTE_MS, step: 1, lastError: "the model service limits the request rate" });

    noteModelSuccess(T + 10 * MINUTE_MS + 1);
    expect(readLlmPause()).toEqual({ pausedUntil: null, step: 0, lastError: null });
  });

  it("keeps an active timeout pause", () => {
    pauseForTimeout(T);
    noteModelSuccess(T + 1000);
    expect(readLlmPause().pausedUntil).toBe(T + 2 * MINUTE_MS);
  });
});

describe("pauseForServiceError", () => {
  it("raises the step once for several failures of one outage", () => {
    pauseForServiceError(new LlmError("overloaded", "503"), T);
    pauseForServiceError(new LlmError("overloaded", "503"), T + 100);
    pauseForServiceError(new LlmError("overloaded", "503"), T + 200);
    expect(readLlmPause()).toEqual({ pausedUntil: T + 200 + 2 * MINUTE_MS, step: 1, lastError: "the model service is overloaded" });

    // The next failure after the pause ends doubles the pause.
    const later = T + 10 * MINUTE_MS;
    pauseForServiceError(new LlmError("overloaded", "503"), later);
    expect(readLlmPause()).toEqual({ pausedUntil: later + 4 * MINUTE_MS, step: 2, lastError: "the model service is overloaded" });
  });

  it("never shortens an active pause, and a longer pause wins with its reason", () => {
    pauseForServiceError(new LlmError("rate_limited", "429"), T);
    pauseForServiceError(new LlmError("overloaded", "503"), T + 100);
    expect(readLlmPause()).toEqual({ pausedUntil: T + 10 * MINUTE_MS, step: 1, lastError: "the model service limits the request rate" });

    pauseForServiceError(new LlmError("auth", "401"), T + 200);
    expect(readLlmPause()).toEqual({ pausedUntil: T + 200 + 60 * MINUTE_MS, step: 1, lastError: "the model key was refused" });
  });
});
