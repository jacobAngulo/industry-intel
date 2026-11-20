import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createEnv } from "@/lib/env";
import { FakeUsageMeter } from "@/test/helpers";

import { FakeLlm, LlmError, getLlm, getWebSearch } from "./index";

const schema = z.object({ answer: z.number(), label: z.string().default("none") });
const request = { task: "judge" as const, schema, system: "sys", user: "user text" };

describe("FakeLlm", () => {
  it("returns the scripted replies in order, validated with the schema of the request", async () => {
    const llm = new FakeLlm().enqueue({ answer: 1 }, { answer: 2, label: "two" });

    const first = await llm.json(request);
    expect(first.data).toEqual({ answer: 1, label: "none" });
    expect(first.model).toBe("fake-judge");
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 50, durationMs: 1 });
    expect((await llm.json({ ...request, task: "analysis" })).model).toBe("fake-analysis");
    expect(llm.pending).toBe(0);
  });

  it("keeps a call log", async () => {
    const llm = new FakeLlm({ handler: () => ({ answer: 7 }) });
    await llm.json({ ...request, usageMetric: "llm_calls_preview", maxOutputTokens: 900 });
    await llm.json({ ...request, user: "second" });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]).toMatchObject({ task: "judge", system: "sys", user: "user text", usageMetric: "llm_calls_preview", maxOutputTokens: 900 });
    expect(llm.calls[0]?.schema).toBe(schema);
    expect(llm.calls[1]?.user).toBe("second");
    expect(llm.reset().calls).toHaveLength(0);
  });

  it("uses the handler when the queue is empty, and the handler gets the request", async () => {
    const llm = new FakeLlm({ handler: (req) => ({ answer: req.user.length }) });
    llm.enqueue({ answer: 99 });
    expect((await llm.json(request)).data.answer).toBe(99);
    expect((await llm.json(request)).data.answer).toBe("user text".length);

    llm.setHandler(async (req) => ({ answer: req.task === "judge" ? 1 : 2 }));
    expect((await llm.json({ ...request, task: "analysis" })).data.answer).toBe(2);
    // A queued function also gets the request.
    llm.enqueue((req: { system: string }) => ({ answer: req.system.length }));
    expect((await llm.json(request)).data.answer).toBe(3);
  });

  it("throws bad_output when a reply does not fit the schema", async () => {
    const llm = new FakeLlm().enqueue({ answer: "not a number" });
    await expect(llm.json(request)).rejects.toMatchObject({ name: "LlmError", kind: "bad_output" });
  });

  it("can be told to throw an LlmError", async () => {
    const llm = new FakeLlm({ handler: () => ({ answer: 1 }) });
    llm.enqueue(new LlmError("rate_limited", "Slow down.", { retryAfterMs: 30_000 }));
    await expect(llm.json(request)).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });

    llm.enqueue({ answer: 5 }).failNext(new LlmError("overloaded", "Busy."));
    await expect(llm.json(request)).rejects.toMatchObject({ kind: "overloaded" });
    expect((await llm.json(request)).data.answer).toBe(5);

    llm.setHandler(() => new LlmError("timeout", "Too slow."));
    await expect(llm.json(request)).rejects.toBeInstanceOf(LlmError);
  });

  it("fails with a clear error when no reply is scripted", async () => {
    await expect(new FakeLlm().json(request)).rejects.toThrow(/no reply is scripted/);
  });

  it("throws no_key when it is not available", async () => {
    const llm = new FakeLlm({ available: false });
    expect(llm.available()).toBe(false);
    await expect(llm.json(request)).rejects.toMatchObject({ kind: "no_key" });
    expect(llm.calls).toHaveLength(1);
    expect(llm.setAvailable(true).available()).toBe(true);
  });

  it("takes one call from the usage meter for each call, and throws budget at the limit", async () => {
    const usage = new FakeUsageMeter({ llm_calls: 1, llm_calls_preview: 1 });
    const llm = new FakeLlm({ usage, handler: () => ({ answer: 1 }) });

    await llm.json(request);
    await expect(llm.json(request)).rejects.toMatchObject({ kind: "budget" });
    await llm.json({ ...request, usageMetric: "llm_calls_preview" });

    expect(usage.today("llm_calls")).toBe(1);
    expect(usage.today("llm_calls_preview")).toBe(1);
    expect(usage.today("llm_input_tokens")).toBe(200);
    expect(usage.today("llm_output_tokens")).toBe(100);
  });
});

describe("the provider with no model key", () => {
  it("getLlm gives a provider that is not available, and getWebSearch gives null", async () => {
    const env = createEnv({ OLLAMA_MODEL_JUDGE: "judge-x" });
    const deps = { env, usage: new FakeUsageMeter(), http: { request: async () => Promise.reject(new Error("no network")) } };
    const llm = getLlm(deps);
    expect(llm.available()).toBe(false);
    expect(llm.modelFor("judge")).toBe("judge-x");
    expect(llm.modelFor("analysis")).toBe("glm-5.3");
    await expect(llm.json(request)).rejects.toMatchObject({ kind: "no_key" });
    expect(getWebSearch(deps)).toBeNull();
  });
});
