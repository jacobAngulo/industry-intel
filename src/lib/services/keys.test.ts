import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activity } from "@/lib/db/schema";
import { getEnv, hasModelKey, hasXToken } from "@/lib/env";
import { readLlmPause, setLlmPause } from "@/lib/pipeline/jobs";
import { installTestDb, type InstalledTestDb } from "@/test/helpers";

import { ServiceError } from "./_manage-errors";
import { getKeyStatuses, removeStoredKey, saveStoredKey } from "./keys";

const actor = { name: "Dana", userId: "c1" };
const SECRET = "ollama-secret-123";

let test: InstalledTestDb;
const saved = { OLLAMA_API_KEY: process.env.OLLAMA_API_KEY, X_BEARER_TOKEN: process.env.X_BEARER_TOKEN };

beforeEach(() => {
  delete process.env.OLLAMA_API_KEY;
  delete process.env.X_BEARER_TOKEN;
  test = installTestDb();
});

afterEach(() => {
  test.cleanup();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("saved API keys", () => {
  it("a saved key reaches getEnv() with no restart, and Remove takes it away", async () => {
    expect(hasModelKey()).toBe(false);
    await saveStoredKey({ name: "OLLAMA_API_KEY", value: `  ${SECRET} ` }, actor);
    expect(getEnv().ollamaApiKey).toBe(SECRET);
    expect(hasModelKey()).toBe(true);
    expect(hasXToken()).toBe(false);

    await removeStoredKey({ name: "OLLAMA_API_KEY" }, actor);
    expect(hasModelKey()).toBe(false);
  });

  it("a saved key wins over .env; after Remove the .env value applies again", async () => {
    process.env.X_BEARER_TOKEN = "from-env";
    expect((await getKeyStatuses()).find((k) => k.name === "X_BEARER_TOKEN")?.source).toBe("env");

    await saveStoredKey({ name: "X_BEARER_TOKEN", value: "from-ui" }, actor);
    expect(getEnv().xBearerToken).toBe("from-ui");
    const status = (await getKeyStatuses()).find((k) => k.name === "X_BEARER_TOKEN");
    expect(status).toMatchObject({ source: "saved", inEnvFile: true, savedBy: "Dana" });

    await removeStoredKey({ name: "X_BEARER_TOKEN" }, actor);
    expect(getEnv().xBearerToken).toBe("from-env");
  });

  it("the statuses and the activity log never hold the value", async () => {
    await saveStoredKey({ name: "OLLAMA_API_KEY", value: SECRET }, actor);
    expect(JSON.stringify(await getKeyStatuses())).not.toContain(SECRET);
    const rows = test.db.select().from(activity).all();
    expect(rows.map((r) => r.summary)).toContain("Saved the Ollama API key.");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("refuses a value with spaces, an empty value, and an unknown name", async () => {
    await expect(saveStoredKey({ name: "OLLAMA_API_KEY", value: "two words" }, actor)).rejects.toBeInstanceOf(ServiceError);
    await expect(saveStoredKey({ name: "OLLAMA_API_KEY", value: "   " }, actor)).rejects.toBeInstanceOf(ServiceError);
    await expect(
      saveStoredKey({ name: "GITHUB_TOKEN" as "OLLAMA_API_KEY", value: "x" }, actor),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(hasModelKey()).toBe(false);
  });

  it("a new model key clears the model pause", async () => {
    setLlmPause({ until: Date.now() + 3_600_000, step: 2, lastError: "The model key was refused." });
    await saveStoredKey({ name: "OLLAMA_API_KEY", value: SECRET }, actor);
    expect(readLlmPause()).toMatchObject({ pausedUntil: null, lastError: null });
  });

  it("getEnv() does not read a database when none is open", () => {
    test.cleanup();
    expect(hasModelKey()).toBe(false);
    test = installTestDb();
  });
});
