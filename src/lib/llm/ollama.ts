// The model provider for the Ollama cloud API (specification §11.3 and §20).
//
// - All HTTP goes through the SafeHttp of the caller.
// - The cloud ignores `format`, so strict JSON comes from: the JSON schema text
//   in the system prompt, an extractor that accepts a code fence and text
//   around the object, zod validation, and ONE repair call that sends the
//   validation errors back. Then the error kind is `bad_output`.
// - Each HTTP call to /api/chat first takes one unit of the usage metric of
//   the request (kind `budget` and no HTTP call when `take` returns false),
//   and adds the token counts after the reply.
// - The thinking text (`message.thinking`) is never read into a result, a
//   log line, or an error. The key is never in a message.
import { z } from "zod";

import type { UsageMeter } from "@/lib/connectors/types";
import type { Env } from "@/lib/env";
import type { HttpRequest, HttpResponse, SafeHttp } from "@/lib/http/types";
import { logEvent } from "@/lib/log";
import { nowMs } from "@/lib/time";

import { errorBodyText, errorForStatus, errorForThrown, safeText } from "./errors";
import { extractJsonValue } from "./extract";
import { LlmError, type LlmJsonRequest, type LlmJsonResult, type LlmProvider, type LlmTask } from "./types";

/** Time limits of one HTTP call to /api/chat (§20). */
export const LLM_TIMEOUT_MS: Record<LlmTask, number> = { judge: 60_000, analysis: 180_000 };
/** The size cap of a model reply (§20). */
export const LLM_MAX_BYTES = 2_000_000;
/** The time limit and size cap of a POST /api/show call. */
export const SHOW_TIMEOUT_MS = 15_000;
export const SHOW_MAX_BYTES = 1_000_000;
/** After a failed /api/show call, the provider asks again after this time. */
export const SHOW_RETRY_AFTER_MS = 10 * 60 * 1000;
/** The longest bad reply that the repair call sends back to the model. */
const MAX_REPAIR_ECHO = 30_000;
/** The longest list of validation errors in the repair call. */
const MAX_REPAIR_ERRORS = 4_000;

const WHAT = "The model service";

/** A logger with the signature of logEvent (tests can replace it). */
export type LlmLog = (level: "info" | "warn" | "error", scope: string, message: string, data?: Record<string, unknown>) => void;

export interface OllamaDeps {
  http: SafeHttp;
  usage: UsageMeter;
  env: Env;
  /** Default: logEvent (console line + `events` row). */
  log?: LlmLog;
}

// ---------------------------------------------------------------------------
// Think policy (§20)
// ---------------------------------------------------------------------------

export type ThinkValue = boolean | string;

/** What /api/show says about thinking. `null` = the call failed. */
export interface ThinkInfo {
  /** `thinking.values`, or null when the reply has no `thinking` field. */
  values: ThinkValue[] | null;
  default: ThinkValue | null;
  /** True when `capabilities` has "thinking" (or the reply has a `thinking` field). */
  capable: boolean;
}

/** The order of the think levels, lowest first. */
const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

/**
 * The `think` value of a request, or `undefined` for "send no think field".
 * - judge: `false`, or the lowest level when the model has no `false` value.
 *   When /api/show failed: `false`.
 * - analysis: "high" when the model has it, else the default of the model
 *   (no field). When /api/show failed: no field.
 * - A model that has no thinking at all gets no field.
 */
export function chooseThink(task: LlmTask, info: ThinkInfo | null): ThinkValue | undefined {
  if (info === null) return task === "judge" ? false : undefined;
  if (!info.capable && info.values === null) return undefined;
  const values = info.values ?? [];
  if (task === "judge") {
    if (values.length === 0 || values.includes(false)) return false;
    const levels = values
      .filter((value): value is string => typeof value === "string")
      .sort((a, b) => rank(a) - rank(b));
    return levels[0] ?? false;
  }
  return values.includes("high") ? "high" : undefined;
}

function rank(level: string): number {
  const index = LEVEL_ORDER.indexOf(level.toLowerCase());
  return index === -1 ? LEVEL_ORDER.length : index;
}

const showSchema = z.object({
  capabilities: z.array(z.string()).optional().catch(undefined),
  thinking: z
    .object({
      values: z.array(z.union([z.boolean(), z.string()])).optional().catch(undefined),
      default: z.union([z.boolean(), z.string()]).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/** Reads the think facts of a /api/show body, or null when the body is not usable. */
export function parseShow(text: string): ThinkInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = showSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { capabilities, thinking } = parsed.data;
  return {
    values: thinking?.values ?? null,
    default: thinking?.default ?? null,
    capable: (capabilities ?? []).includes("thinking") || thinking !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

const schemaTextCache = new WeakMap<object, string>();

/** The JSON schema text of a zod schema (the input shape: defaults are optional for the model). */
export function schemaText(schema: z.ZodType): string {
  const cached = schemaTextCache.get(schema);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }));
  } catch {
    // A schema with a cycle or an exotic type: the model still gets the rule, and zod still checks.
    text = '{"type":"object"}';
  }
  schemaTextCache.set(schema, text);
  return text;
}

export const JSON_INSTRUCTION =
  "Reply with one JSON object and nothing else: no Markdown, no code fence, no text before or after the object. " +
  "The object must obey this JSON schema:";

export function buildSystemPrompt(system: string, schema: z.ZodType): string {
  return `${system.trim()}\n\n${JSON_INSTRUCTION}\n${schemaText(schema)}`;
}

export function buildRepairPrompt(problem: string): string {
  return [
    "Your reply did not pass the check. The errors:",
    problem.length > MAX_REPAIR_ERRORS ? `${problem.slice(0, MAX_REPAIR_ERRORS)}…` : problem,
    "Reply again with the complete, corrected JSON object and nothing else. Keep the values that were correct.",
  ].join("\n");
}

type Check<T> = { ok: true; data: T } | { ok: false; problem: string };

export function checkReply<T>(schema: z.ZodType<T>, content: string): Check<T> {
  const extracted = extractJsonValue(content);
  if (!extracted.ok) return { ok: false, problem: extracted.error };
  const parsed = schema.safeParse(extracted.value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, problem: z.prettifyError(parsed.error) };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatReply {
  model: string;
  content: string;
  doneReason: string;
  inputTokens: number;
  outputTokens: number;
}

const chatBodySchema = z.object({
  message: z.object({ content: z.string().catch("") }).partial().optional().catch(undefined),
  done_reason: z.string().optional().catch(undefined),
  prompt_eval_count: z.number().optional().catch(undefined),
  eval_count: z.number().optional().catch(undefined),
  error: z.unknown().optional(),
});

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export class OllamaLlm implements LlmProvider {
  readonly name = "ollama";

  readonly #http: SafeHttp;
  readonly #usage: UsageMeter;
  readonly #env: Env;
  readonly #log: LlmLog;
  /** The model in use for each task: the fallback after a 404 on the primary model. */
  readonly #switched: Partial<Record<LlmTask, string>> = {};
  readonly #think = new Map<string, { info: ThinkInfo | null; at: number; pending?: Promise<ThinkInfo | null> }>();

  constructor(deps: OllamaDeps) {
    this.#http = deps.http;
    this.#usage = deps.usage;
    this.#env = deps.env;
    this.#log = deps.log ?? logEvent;
  }

  available(): boolean {
    return this.#env.ollamaApiKey !== undefined;
  }

  modelFor(task: LlmTask): string {
    return this.#switched[task] ?? this.#primary(task);
  }

  #primary(task: LlmTask): string {
    return task === "judge" ? this.#env.ollamaModelJudge : this.#env.ollamaModelAnalysis;
  }

  #fallback(task: LlmTask): string {
    return task === "judge" ? this.#env.ollamaModelJudgeFallback : this.#env.ollamaModelAnalysisFallback;
  }

  async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    const key = this.#env.ollamaApiKey;
    if (key === undefined) throw new LlmError("no_key", "The model key is missing. Save the Ollama API key in Settings → API keys (or set OLLAMA_API_KEY in .env).");
    if (req.signal?.aborted) throw new LlmError("timeout", "The model call was stopped before it started.");

    const started = performance.now();
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(req.system, req.schema) },
      { role: "user", content: req.user },
    ];

    const first = await this.#chat(req, messages, key);
    let inputTokens = first.inputTokens;
    let outputTokens = first.outputTokens;
    const usage = () => ({ inputTokens, outputTokens, durationMs: Math.round(performance.now() - started) });

    if (first.doneReason === "length") throw cutError(first.model);
    const firstCheck = checkReply(req.schema, first.content);
    if (firstCheck.ok) return { data: firstCheck.data, usage: usage(), model: first.model };

    const echo = first.content.length > MAX_REPAIR_ECHO ? first.content.slice(0, MAX_REPAIR_ECHO) : first.content;
    const second = await this.#chat(
      req,
      [...messages, { role: "assistant", content: echo }, { role: "user", content: buildRepairPrompt(firstCheck.problem) }],
      key,
    );
    inputTokens += second.inputTokens;
    outputTokens += second.outputTokens;

    if (second.doneReason === "length") throw cutError(second.model);
    const secondCheck = checkReply(req.schema, second.content);
    if (secondCheck.ok) return { data: secondCheck.data, usage: usage(), model: second.model };
    throw new LlmError(
      "bad_output",
      `The model reply did not fit the schema after one repair (${second.model}): ${safeText(secondCheck.problem, key, 300)}`,
    );
  }

  /** One logical chat call: the model in use, and the fallback model after a 404 (§20). */
  async #chat<T>(req: LlmJsonRequest<T>, messages: ChatMessage[], key: string): Promise<ChatReply> {
    const model = this.modelFor(req.task);
    const fallback = this.#fallback(req.task);
    try {
      return await this.#chatOnce(req, model, messages, key);
    } catch (error) {
      if (!(error instanceof LlmError) || error.kind !== "not_found" || model === fallback) throw error;
      if (this.#switched[req.task] !== fallback) {
        this.#switched[req.task] = fallback;
        this.#log("warn", "llm", `The model ${model} was not found. The ${req.task} calls use ${fallback} from now on.`, {
          task: req.task,
          from: model,
          to: fallback,
        });
      }
      try {
        return await this.#chatOnce(req, fallback, messages, key);
      } catch (second) {
        if (second instanceof LlmError && second.kind === "not_found") {
          throw new LlmError(
            "not_found",
            `No usable model for the ${req.task} task: ${model} and ${fallback} were not found. Set OLLAMA_MODEL_${req.task === "judge" ? "JUDGE" : "ANALYSIS"} to a current model.`,
            { cause: second },
          );
        }
        throw second;
      }
    }
  }

  /** One HTTP call to /api/chat. */
  async #chatOnce<T>(req: LlmJsonRequest<T>, model: string, messages: ChatMessage[], key: string): Promise<ChatReply> {
    const metric = req.usageMetric ?? "llm_calls";
    if (!this.#usage.take(metric, 1)) {
      throw new LlmError(
        "budget",
        metric === "llm_calls_preview"
          ? "The preview model call limit for today is used."
          : "The model call limit for today is used.",
      );
    }

    const think = chooseThink(req.task, await this.#thinkInfo(model, key, req.signal));
    const options: Record<string, number> = { temperature: 0 };
    if (req.maxOutputTokens !== undefined) options.num_predict = Math.max(1, Math.round(req.maxOutputTokens));
    const body: Record<string, unknown> = { model, messages, stream: false, options };
    if (think !== undefined) body.think = think;

    const res = await this.#post(`${this.#env.ollamaHost}/api/chat`, body, key, {
      timeoutMs: LLM_TIMEOUT_MS[req.task],
      maxBytes: LLM_MAX_BYTES,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!res.ok) throw errorForStatus({ status: res.status, body: res.text, headers: res.headers, what: WHAT, key });

    let raw: unknown;
    try {
      raw = JSON.parse(res.text);
    } catch {
      throw new LlmError("overloaded", `${WHAT} sent an answer that is not JSON (HTTP ${res.status}).`);
    }
    const parsed = chatBodySchema.safeParse(raw);
    if (!parsed.success) throw new LlmError("overloaded", `${WHAT} sent an answer of an unknown shape.`);
    const data = parsed.data;
    if (data.error !== undefined && data.error !== null) {
      throw new LlmError("overloaded", `${WHAT} reported an error: ${safeText(errorBodyText(res.text), key)}`);
    }

    const reply: ChatReply = {
      model,
      content: data.message?.content ?? "",
      doneReason: data.done_reason ?? "",
      inputTokens: tokenCount(data.prompt_eval_count),
      outputTokens: tokenCount(data.eval_count),
    };
    if (reply.inputTokens > 0) this.#usage.add("llm_input_tokens", reply.inputTokens);
    if (reply.outputTokens > 0) this.#usage.add("llm_output_tokens", reply.outputTokens);
    return reply;
  }

  /** The think facts of a model: one /api/show call for each model, kept in memory. */
  async #thinkInfo(model: string, key: string, signal: AbortSignal | undefined): Promise<ThinkInfo | null> {
    const entry = this.#think.get(model);
    if (entry?.pending) return entry.pending;
    if (entry && (entry.info !== null || nowMs() - entry.at < SHOW_RETRY_AFTER_MS)) return entry.info;

    const pending = this.#show(model, key, signal);
    this.#think.set(model, { info: null, at: nowMs(), pending });
    const info = await pending;
    this.#think.set(model, { info, at: nowMs() });
    return info;
  }

  async #show(model: string, key: string, signal: AbortSignal | undefined): Promise<ThinkInfo | null> {
    try {
      const res = await this.#post(`${this.#env.ollamaHost}/api/show`, { model }, key, {
        timeoutMs: SHOW_TIMEOUT_MS,
        maxBytes: SHOW_MAX_BYTES,
        ...(signal ? { signal } : {}),
      });
      return res.ok ? parseShow(res.text) : null;
    } catch {
      return null;
    }
  }

  async #post(
    url: string,
    body: unknown,
    key: string,
    extra: Pick<HttpRequest, "timeoutMs" | "maxBytes" | "signal">,
  ): Promise<HttpResponse> {
    try {
      return await this.#http.request({
        url,
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        ...extra,
      });
    } catch (error) {
      throw errorForThrown(error, WHAT, key);
    }
  }
}

function cutError(model: string): LlmError {
  return new LlmError("bad_output", `The model reply was cut at the output token limit (${model}).`);
}
