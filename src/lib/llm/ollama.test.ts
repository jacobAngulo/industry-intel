import { describe, expect, it } from "vitest";
import { z } from "zod";

import { events } from "@/lib/db/schema";
import { HttpError, type HttpRequest } from "@/lib/http/types";
import { FakeHttp, FakeUsageMeter, installTestDb, loadFixture, makeEnv, type FakeHttpReply } from "@/test/helpers";

import { LlmError, getLlm } from "./index";
import { JSON_INSTRUCTION, LLM_MAX_BYTES, chooseThink, parseShow, type LlmLog } from "./ollama";

const KEY = "test-key-not-real-0001";
const HOST = "https://ollama.com";
const CHAT = `${HOST}/api/chat`;
const SHOW = `${HOST}/api/show`;

/** The shape of the recorded judge replies in __fixtures__. */
const judgeSchema = z.object({
  facts: z.object({
    headline: z.string(),
    what_changed: z.string(),
    entities: z.array(z.string()),
    item_type: z.string(),
    affected_version: z.string().nullable(),
  }),
  same_story: z.object({
    decision: z.enum(["new", "same"]),
    story_id: z.string().nullable(),
    confidence: z.number().int().min(0).max(100),
  }),
  feeds: z
    .array(z.object({ feed_id: z.string(), relevant: z.boolean(), score: z.number().int().min(0).max(10), reason: z.string() }))
    .length(3),
});

const request = { task: "judge" as const, schema: judgeSchema, system: "You are an editor.", user: "ITEM: invented test item" };

const showFixture = loadFixture("show-deepseek-v4.1-flash.json");
const okReply = loadFixture("judge-structured.deepseek-v4.1-flash.json");
const fencedReply = loadFixture("judge-structured.fenced.glm-5.3-flash.json");
const thinkingReply = loadFixture("judge-structured.with-thinking.trimmed.json");
const truncatedReply = loadFixture("judge-truncated.num_predict-40.json");

/** The content (a JSON string) of the recorded valid reply. */
const validContent = (JSON.parse(okReply) as { message: { content: string } }).message.content;

function chatBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "deepseek-v4.1-flash",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 100,
    eval_count: 40,
    ...extra,
  });
}

type ChatStep = FakeHttpReply | ((req: HttpRequest) => FakeHttpReply);

interface Setup {
  http: FakeHttp;
  usage: FakeUsageMeter;
  logs: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
  llm: ReturnType<typeof getLlm>;
  chatBodies: () => Array<Record<string, unknown>>;
  chatRequests: () => HttpRequest[];
}

/** A provider over a FakeHttp. `chat` replies are used in order; the last one repeats. */
function setup(
  chat: ChatStep[],
  opts: { show?: FakeHttpReply; env?: Record<string, string>; limits?: ConstructorParameters<typeof FakeUsageMeter>[0] } = {},
): Setup {
  const http = new FakeHttp();
  let index = 0;
  http.on(SHOW, opts.show ?? { text: showFixture, headers: { "content-type": "application/json" } });
  http.on(CHAT, (req) => {
    const step = chat[Math.min(index, chat.length - 1)]!;
    index += 1;
    return typeof step === "function" ? step(req) : step;
  });
  const usage = new FakeUsageMeter(opts.limits ?? {});
  const logs: Setup["logs"] = [];
  const log: LlmLog = (level, _scope, message, data) => logs.push({ level, message, ...(data ? { data } : {}) });
  const env = makeEnv({ OLLAMA_API_KEY: KEY, ...opts.env });
  const llm = getLlm({ http, usage, env, log });
  const chatRequests = () => http.requests.filter((req) => req.url === CHAT);
  return {
    http,
    usage,
    logs,
    llm,
    chatRequests,
    chatBodies: () => chatRequests().map((req) => JSON.parse(req.body ?? "{}") as Record<string, unknown>),
  };
}

describe("OllamaLlm.json", () => {
  it("returns the validated data, the usage, and the model, with the request of §20", async () => {
    const t = setup([{ text: okReply, headers: { "content-type": "application/json" } }]);
    const result = await t.llm.json(request);

    expect(result.data.same_story).toEqual({ decision: "new", story_id: null, confidence: 95 });
    expect(result.data.feeds.map((feed) => feed.score)).toEqual([1, 10, 0]);
    expect(result.model).toBe("deepseek-v4.1-flash");
    expect(result.usage.inputTokens).toBe(719);
    expect(result.usage.outputTokens).toBe(284);
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.usage.today("llm_calls")).toBe(1);
    expect(t.usage.today("llm_input_tokens")).toBe(719);
    expect(t.usage.today("llm_output_tokens")).toBe(284);

    const [req] = t.chatRequests();
    expect(req?.method).toBe("POST");
    expect(req?.headers?.Authorization).toBe(`Bearer ${KEY}`);
    expect(req?.timeoutMs).toBe(60_000);
    expect(req?.maxBytes).toBe(LLM_MAX_BYTES);
    const [body] = t.chatBodies();
    expect(body).toMatchObject({ model: "deepseek-v4.1-flash", stream: false, think: false, options: { temperature: 0 } });
    expect(body?.options).not.toHaveProperty("num_predict");
    expect(body).not.toHaveProperty("format");
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content.startsWith("You are an editor.")).toBe(true);
    expect(messages[0]?.content).toContain(JSON_INSTRUCTION);
    expect(messages[0]?.content).toContain('"same_story"');
    expect(messages[1]?.content).toBe(request.user);
  });

  it("reads /api/show one time for each model and sends num_predict when maxOutputTokens is set", async () => {
    const t = setup([{ text: okReply }]);
    await t.llm.json({ ...request, maxOutputTokens: 1200 });
    await t.llm.json(request);
    expect(t.http.count(SHOW)).toBe(1);
    expect(JSON.parse(t.http.requests.find((req) => req.url === SHOW)?.body ?? "{}")).toEqual({ model: "deepseek-v4.1-flash" });
    expect(t.chatBodies()[0]?.options).toEqual({ temperature: 0, num_predict: 1200 });
  });

  it("accepts a reply in a code fence", async () => {
    const t = setup([{ text: fencedReply }]);
    const result = await t.llm.json(request);
    expect(result.data.same_story).toEqual({ decision: "same", story_id: "S-101", confidence: 95 });
    expect(t.chatRequests()).toHaveLength(1);
  });

  it("accepts text around the object", async () => {
    const t = setup([{ text: chatBody(`Here is the result:\n${validContent}\nI hope this helps.`) }]);
    expect((await t.llm.json(request)).data.feeds).toHaveLength(3);
  });

  it("never returns or logs the thinking text", async () => {
    const t = setup([{ text: thinkingReply }]);
    const result = await t.llm.json(request);
    const thinking = (JSON.parse(thinkingReply) as { message: { thinking: string } }).message.thinking;
    expect(thinking.length).toBeGreaterThan(20);
    expect(JSON.stringify(result)).not.toContain(thinking.slice(0, 20));
    expect(JSON.stringify(t.logs)).not.toContain(thinking.slice(0, 20));
  });

  it("makes one repair call with the validation errors, and counts 2 calls", async () => {
    const t = setup([{ text: chatBody('{"facts": 1, "feeds": []}') }, { text: chatBody(validContent, { prompt_eval_count: 300, eval_count: 60 }) }]);
    const result = await t.llm.json(request);

    expect(result.data.facts.item_type).toBe("security");
    expect(result.usage).toMatchObject({ inputTokens: 400, outputTokens: 100 });
    expect(t.usage.today("llm_calls")).toBe(2);
    expect(t.usage.today("llm_input_tokens")).toBe(400);

    const repair = t.chatBodies()[1]?.messages as Array<{ role: string; content: string }>;
    expect(repair.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(repair[2]?.content).toBe('{"facts": 1, "feeds": []}');
    expect(repair[3]?.content).toContain("did not pass the check");
    expect(repair[3]?.content).toContain("same_story");
    expect(repair[3]?.content).toContain("facts");
  });

  it("repairs a reply that has no JSON at all", async () => {
    const analysisText = loadFixture("analysis-nostream.glm-5.3.trimmed.json");
    const t = setup([{ text: analysisText }, { text: okReply }]);
    await expect(t.llm.json(request)).resolves.toMatchObject({ model: "deepseek-v4.1-flash" });
    const repair = t.chatBodies()[1]?.messages as Array<{ role: string; content: string }>;
    expect(repair[3]?.content).toContain("no JSON object");
  });

  it("throws bad_output when the reply is invalid two times", async () => {
    const t = setup([{ text: chatBody('{"facts": {}}') }, { text: chatBody("still not valid") }]);
    await expect(t.llm.json(request)).rejects.toMatchObject({ name: "LlmError", kind: "bad_output" });
    expect(t.chatRequests()).toHaveLength(2);
    expect(t.usage.today("llm_calls")).toBe(2);
  });

  it("treats done_reason length as bad_output with no repair call", async () => {
    const t = setup([{ text: truncatedReply }]);
    await expect(t.llm.json(request)).rejects.toMatchObject({ kind: "bad_output", message: expect.stringMatching(/cut/) });
    expect(t.chatRequests()).toHaveLength(1);
    expect(t.usage.today("llm_output_tokens")).toBe(40);
  });

  it("maps 401 to auth, with no key in the message", async () => {
    const t = setup([{ status: 401, text: loadFixture("error-401-wrong-key.api-chat.json") }]);
    const error = await t.llm.json(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "auth" });
    expect((error as Error).message).toContain("Unauthorized");
    expect((error as Error).message).not.toContain(KEY);
    expect(t.chatRequests()).toHaveLength(1);
  });

  it("maps 403 to auth and 402 to payment", async () => {
    await expect(setup([{ status: 403, text: '{"error":"suspended"}' }]).llm.json(request)).rejects.toMatchObject({ kind: "auth" });
    await expect(setup([{ status: 402, text: '{"error":"no credits"}' }]).llm.json(request)).rejects.toMatchObject({ kind: "payment" });
  });

  it("maps 400 to bad_request and removes the key from an echoed body", async () => {
    const recorded = await setup([{ status: 400, text: loadFixture("error-400-malformed-json.api-chat.json") }])
      .llm.json(request)
      .catch((e: unknown) => e);
    expect(recorded).toMatchObject({ kind: "bad_request" });

    const echoed = await setup([{ status: 400, text: JSON.stringify({ error: `bad header Bearer ${KEY}` }) }])
      .llm.json(request)
      .catch((e: unknown) => e);
    expect((echoed as Error).message).not.toContain(KEY);
    expect((echoed as Error).message).toContain("[key]");
  });

  it("switches to the fallback model after a 404 on the primary model, with a warn event", async () => {
    const notFound = loadFixture("error-404-unknown-model.api-chat.json");
    const t = setup([
      { status: 404, text: notFound, headers: { "content-type": "text/plain; charset=utf-8" } },
      { text: chatBody(validContent) },
    ]);
    expect(t.llm.modelFor("judge")).toBe("deepseek-v4.1-flash");

    const result = await t.llm.json(request);
    expect(result.model).toBe("glm-5.3-flash");
    expect(t.chatBodies().map((body) => body.model)).toEqual(["deepseek-v4.1-flash", "glm-5.3-flash"]);
    expect(t.usage.today("llm_calls")).toBe(2);
    expect(t.logs).toEqual([
      expect.objectContaining({ level: "warn", data: { task: "judge", from: "deepseek-v4.1-flash", to: "glm-5.3-flash" } }),
    ]);
    expect(t.llm.modelFor("judge")).toBe("glm-5.3-flash");
    expect(t.llm.modelFor("analysis")).toBe("glm-5.3");

    // The rest of the process uses the fallback model, with no new warn event.
    await t.llm.json(request);
    expect(t.chatBodies().map((body) => body.model)).toEqual(["deepseek-v4.1-flash", "glm-5.3-flash", "glm-5.3-flash"]);
    expect(t.logs).toHaveLength(1);
  });

  it("writes the warn event of the switch to the events table by default", async () => {
    const db = installTestDb();
    try {
      const http = new FakeHttp()
        .on(SHOW, { status: 500, text: "" })
        .on(CHAT, (req) =>
          JSON.parse(req.body ?? "{}").model === "deepseek-v4.1-flash" ? { status: 404, text: "{}" } : { text: chatBody(validContent) },
        );
      const llm = getLlm({ http, usage: new FakeUsageMeter(), env: makeEnv({ OLLAMA_API_KEY: KEY }) });
      await llm.json(request);
      const rows = db.db.select().from(events).all();
      expect(rows).toEqual([expect.objectContaining({ level: "warn", scope: "llm" })]);
      expect(rows[0]?.message).toContain("glm-5.3-flash");
    } finally {
      db.cleanup();
    }
  });

  it("throws not_found when the fallback model also answers 404", async () => {
    const t = setup([{ status: 404, text: loadFixture("error-404-unknown-model.api-chat.json") }]);
    const error = await t.llm.json(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "not_found" });
    expect((error as Error).message).toContain("deepseek-v4.1-flash");
    expect((error as Error).message).toContain("glm-5.3-flash");
    expect(t.chatRequests()).toHaveLength(2);
  });

  it("maps 429 to rate_limited with the Retry-After value", async () => {
    const t = setup([{ status: 429, text: '{"error":"too many requests"}', headers: { "Retry-After": "30" } }]);
    await expect(t.llm.json(request)).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
    const plain = setup([{ status: 429, text: "" }]);
    const error = await plain.llm.json(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "rate_limited" });
    expect((error as LlmError).retryAfterMs).toBeUndefined();
  });

  it.each([500, 502, 503, 504, 529])("maps %i to overloaded", async (status) => {
    await expect(setup([{ status, text: "upstream error" }]).llm.json(request)).rejects.toMatchObject({ kind: "overloaded" });
  });

  it("maps an error body with status 200, and a body that is not JSON, to overloaded", async () => {
    await expect(setup([{ text: '{"error":"model is busy"}' }]).llm.json(request)).rejects.toMatchObject({ kind: "overloaded" });
    await expect(setup([{ text: "<html>gateway</html>" }]).llm.json(request)).rejects.toMatchObject({ kind: "overloaded" });
  });

  it("maps an HttpError timeout to timeout and a connection error to network", async () => {
    await expect(setup([{ error: new HttpError("timeout", "The request took too long.") }]).llm.json(request)).rejects.toMatchObject({
      kind: "timeout",
    });
    await expect(setup([{ error: new HttpError("network", "ECONNRESET") }]).llm.json(request)).rejects.toMatchObject({
      kind: "network",
    });
    await expect(setup([{ error: new TypeError("fetch failed") }]).llm.json(request)).rejects.toMatchObject({ kind: "network" });
    await expect(setup([{ error: new HttpError("too_large", "Too large.") }]).llm.json(request)).rejects.toMatchObject({
      kind: "bad_output",
    });
  });

  it("throws budget with no HTTP call when the usage meter says no", async () => {
    const t = setup([{ text: okReply }], { limits: { llm_calls: 0 } });
    await expect(t.llm.json(request)).rejects.toMatchObject({ kind: "budget" });
    expect(t.http.requests).toHaveLength(0);
  });

  it("takes the usage metric of the request", async () => {
    const t = setup([{ text: okReply }], { limits: { llm_calls: 0, llm_calls_preview: 1 } });
    await t.llm.json({ ...request, usageMetric: "llm_calls_preview" });
    expect(t.usage.today("llm_calls_preview")).toBe(1);
    expect(t.usage.today("llm_calls")).toBe(0);
    await expect(t.llm.json({ ...request, usageMetric: "llm_calls_preview" })).rejects.toMatchObject({ kind: "budget" });
    expect(t.chatRequests()).toHaveLength(1);
  });

  it("throws budget before the repair call when the limit is used", async () => {
    const t = setup([{ text: chatBody("not json") }, { text: okReply }], { limits: { llm_calls: 1 } });
    await expect(t.llm.json(request)).rejects.toMatchObject({ kind: "budget" });
    expect(t.chatRequests()).toHaveLength(1);
  });

  it("is not available with no key, and json() throws no_key with no HTTP call", async () => {
    const http = new FakeHttp();
    const llm = getLlm({ http, usage: new FakeUsageMeter(), env: makeEnv() });
    expect(llm.available()).toBe(false);
    await expect(llm.json(request)).rejects.toMatchObject({ kind: "no_key" });
    expect(http.requests).toHaveLength(0);
  });

  it("throws timeout with no HTTP call when the signal is already aborted", async () => {
    const t = setup([{ text: okReply }]);
    const controller = new AbortController();
    controller.abort();
    await expect(t.llm.json({ ...request, signal: controller.signal })).rejects.toMatchObject({ kind: "timeout" });
    expect(t.http.requests).toHaveLength(0);
    expect(t.usage.today("llm_calls")).toBe(0);
  });

  it("uses the models of the environment", async () => {
    const t = setup([{ text: okReply }], { env: { OLLAMA_MODEL_JUDGE: "judge-a", OLLAMA_MODEL_ANALYSIS: "analysis-a", OLLAMA_HOST: "https://example.test/" } });
    expect(t.llm.modelFor("judge")).toBe("judge-a");
    expect(t.llm.modelFor("analysis")).toBe("analysis-a");
    const http = new FakeHttp().on(/\/api\/show$/, { status: 500 }).on("https://example.test/api/chat", { text: okReply });
    const llm = getLlm({ http, usage: new FakeUsageMeter(), env: makeEnv({ OLLAMA_API_KEY: KEY, OLLAMA_HOST: "https://example.test/" }) });
    await llm.json(request);
    expect(http.urls).toEqual(["https://example.test/api/show", "https://example.test/api/chat"]);
  });
});

describe("the think policy", () => {
  const analysisRequest = { ...request, task: "analysis" as const };

  it("sends think false for judge and think high for analysis, from the /api/show fixture", async () => {
    const t = setup([{ text: okReply }]);
    await t.llm.json(request);
    await t.llm.json(analysisRequest);
    const bodies = t.chatBodies();
    expect(bodies[0]).toMatchObject({ model: "deepseek-v4.1-flash", think: false });
    expect(bodies[1]).toMatchObject({ model: "glm-5.3", think: "high" });
    expect(t.chatRequests()[1]?.timeoutMs).toBe(180_000);
    // One /api/show call for each model.
    expect(t.http.requests.filter((req) => req.url === SHOW).map((req) => JSON.parse(req.body ?? "{}").model)).toEqual([
      "deepseek-v4.1-flash",
      "glm-5.3",
    ]);
  });

  it("sends think false for judge and no think field for analysis when /api/show fails", async () => {
    const t = setup([{ text: okReply }], { show: { status: 404, text: loadFixture("error-404-unknown-model.api-show.json") } });
    await t.llm.json(request);
    await t.llm.json(analysisRequest);
    const bodies = t.chatBodies();
    expect(bodies[0]).toMatchObject({ think: false });
    expect(bodies[1]).not.toHaveProperty("think");
  });

  it("sends think false for judge when /api/show throws", async () => {
    const t = setup([{ text: okReply }], { show: { error: new HttpError("network", "down") } });
    await t.llm.json(request);
    expect(t.chatBodies()[0]).toMatchObject({ think: false });
  });

  it("chooses the lowest level for judge when the model has no false value", () => {
    const glm = { values: ["low", "high", "max"], default: "max", capable: true };
    expect(chooseThink("judge", glm)).toBe("low");
    expect(chooseThink("analysis", glm)).toBe("high");
    const gpt = { values: ["high", "medium", "low"], default: "medium", capable: true };
    expect(chooseThink("judge", gpt)).toBe("low");
    expect(chooseThink("analysis", gpt)).toBe("high");
    const toggle = { values: [false, true], default: true, capable: true };
    expect(chooseThink("judge", toggle)).toBe(false);
    expect(chooseThink("analysis", toggle)).toBeUndefined();
    expect(chooseThink("judge", { values: null, default: null, capable: true })).toBe(false);
    expect(chooseThink("judge", { values: null, default: null, capable: false })).toBeUndefined();
    expect(chooseThink("judge", null)).toBe(false);
    expect(chooseThink("analysis", null)).toBeUndefined();
  });

  it("parses the /api/show reply", () => {
    expect(parseShow(showFixture)).toEqual({ values: [false, "low", "high", "max"], default: "high", capable: true });
    expect(parseShow('{"capabilities":["completion"]}')).toEqual({ values: null, default: null, capable: false });
    expect(parseShow("not json")).toBeNull();
    expect(parseShow("[1,2]")).toBeNull();
  });
});
