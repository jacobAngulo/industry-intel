import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDatabasePath } from "@/lib/db/client";

import { createEnv, getEnv, hasMailbox, hasModelKey, hasXToken } from "./env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("env", () => {
  it("gives the defaults of the specification", () => {
    const env = createEnv({});
    expect(env.ollamaApiKey).toBeUndefined();
    expect(env.ollamaHost).toBe("https://ollama.com");
    expect(env.ollamaModelJudge).toBe("deepseek-v4.1-flash");
    expect(env.ollamaModelJudgeFallback).toBe("glm-5.3-flash");
    expect(env.ollamaModelAnalysis).toBe("glm-5.3");
    expect(env.ollamaModelAnalysisFallback).toBe("kimi-k3.1-pro");
    expect(env.llmMaxCallsPerDay).toBe(1500);
    expect(env.xMaxPostsPerDay).toBe(300);
    expect(env.webSearchMaxPerDay).toBe(50);
    expect(env.imapPort).toBe(993);
    expect(env.imapMailbox).toBe("INBOX");
    expect(env.port).toBe(4400);
    expect(env.databasePath).toBe(path.resolve("data/app.db"));
  });

  it("reads the values, trims them, and treats an empty value as absent", () => {
    const env = createEnv({
      OLLAMA_API_KEY: "  test-key  ",
      OLLAMA_HOST: "https://ollama.example.test/",
      X_BEARER_TOKEN: "   ",
      LLM_MAX_CALLS_PER_DAY: "25",
      IMAP_PORT: "1993",
      DATABASE_PATH: "./tmp/other.db",
    });
    expect(env.ollamaApiKey).toBe("test-key");
    expect(env.has("OLLAMA_API_KEY")).toBe(true);
    expect(env.ollamaHost).toBe("https://ollama.example.test");
    expect(env.xBearerToken).toBeUndefined();
    expect(env.has("X_BEARER_TOKEN")).toBe(false);
    expect(env.llmMaxCallsPerDay).toBe(25);
    expect(env.imapPort).toBe(1993);
    expect(env.databasePath).toBe(path.resolve("tmp/other.db"));
    expect(hasModelKey(env)).toBe(true);
    expect(hasXToken(env)).toBe(false);
  });

  it("needs host, user, and password for the mailbox", () => {
    expect(hasMailbox(createEnv({ IMAP_HOST: "imap.example.test", IMAP_USER: "news" }))).toBe(false);
    expect(hasMailbox(createEnv({ IMAP_HOST: "imap.example.test", IMAP_USER: "news", IMAP_PASSWORD: "x" }))).toBe(true);
  });

  it("shows no value when it is printed", () => {
    const env = createEnv({ OLLAMA_API_KEY: "secret-value", X_BEARER_TOKEN: "secret-token" });
    expect(JSON.stringify(env)).toBe("{}");
    expect(Object.keys(env)).toEqual([]);
    expect(String(env)).not.toContain("secret");
  });

  it("getEnv() reads process.env at the time of the call and resolves DATABASE_PATH as the client does", () => {
    const env = getEnv();
    process.env.DATABASE_PATH = "/tmp/industry-intel-env-test/a.db";
    process.env.OLLAMA_MODEL_JUDGE = "custom-model";
    expect(env.databasePath).toBe("/tmp/industry-intel-env-test/a.db");
    expect(env.databasePath).toBe(resolveDatabasePath());
    expect(env.ollamaModelJudge).toBe("custom-model");
    delete process.env.OLLAMA_MODEL_JUDGE;
    expect(env.ollamaModelJudge).toBe("deepseek-v4.1-flash");
  });
});
