// A scripted model for tests. No network.
//
//   const llm = new FakeLlm();
//   llm.enqueue({ feeds: [...] });                 // the next call returns this (after schema validation)
//   llm.enqueue(new LlmError("overloaded", "x"));  // the call after that throws
//   llm.setHandler((req) => makeReply(req.user));  // used when the queue is empty
//   expect(llm.calls).toHaveLength(2);
import type { UsageMeter } from "@/lib/connectors/types";

import {
  LlmError,
  type LlmJsonRequest,
  type LlmJsonResult,
  type LlmProvider,
  type LlmTask,
  type LlmUsage,
} from "./types";

/** What the fake keeps for each call (all fields of the request except the signal). */
export type FakeLlmCall = Omit<LlmJsonRequest<unknown>, "signal">;

/** A reply: the data, an LlmError to throw, or a function of the request that returns one of them. */
export type FakeLlmReply = unknown | LlmError | ((req: FakeLlmCall) => unknown | Promise<unknown>);

export type FakeLlmHandler = (req: FakeLlmCall) => unknown | Promise<unknown>;

export interface FakeLlmOptions {
  /** Default true. `false` makes available() false and json() throw kind `no_key`. */
  available?: boolean;
  handler?: FakeLlmHandler;
  /** Model names for each task. Defaults: "fake-judge", "fake-analysis". */
  models?: Partial<Record<LlmTask, string>>;
  /** When given, each call takes one unit of its usage metric first (kind `budget` when the limit is used). */
  usage?: UsageMeter;
  /** The usage numbers that each call reports. */
  callUsage?: Partial<LlmUsage>;
}

export class FakeLlm implements LlmProvider {
  readonly name = "fake";
  /** The call log, oldest first. */
  readonly calls: FakeLlmCall[] = [];

  #available: boolean;
  #handler: FakeLlmHandler | null;
  #queue: FakeLlmReply[] = [];
  #models: Record<LlmTask, string>;
  #usage: UsageMeter | undefined;
  #callUsage: LlmUsage;

  constructor(options: FakeLlmOptions = {}) {
    this.#available = options.available ?? true;
    this.#handler = options.handler ?? null;
    this.#models = { judge: "fake-judge", analysis: "fake-analysis", ...options.models };
    this.#usage = options.usage;
    this.#callUsage = { inputTokens: 100, outputTokens: 50, durationMs: 1, ...options.callUsage };
  }

  /** Adds replies to the queue. The queue is used before the handler. */
  enqueue(...replies: FakeLlmReply[]): this {
    this.#queue.push(...replies);
    return this;
  }

  /** The next call throws this error (it goes to the front of the queue). */
  failNext(error: LlmError): this {
    this.#queue.unshift(error);
    return this;
  }

  /** The function that answers when the queue is empty. `null` removes it. */
  setHandler(handler: FakeLlmHandler | null): this {
    this.#handler = handler;
    return this;
  }

  setAvailable(available: boolean): this {
    this.#available = available;
    return this;
  }

  /** The number of replies that wait in the queue. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Empties the queue and the call log. The handler stays. */
  reset(): this {
    this.#queue = [];
    this.calls.length = 0;
    return this;
  }

  available(): boolean {
    return this.#available;
  }

  modelFor(task: LlmTask): string {
    return this.#models[task];
  }

  async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    const call: FakeLlmCall = {
      task: req.task,
      schema: req.schema,
      system: req.system,
      user: req.user,
      ...(req.usageMetric === undefined ? {} : { usageMetric: req.usageMetric }),
      ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
    };
    this.calls.push(call);

    if (!this.#available) throw new LlmError("no_key", "The model key is missing.");
    if (req.signal?.aborted) throw new LlmError("timeout", "The model call was stopped.");
    if (this.#usage && !this.#usage.take(req.usageMetric ?? "llm_calls", 1)) {
      throw new LlmError("budget", "The model call limit for today is used.");
    }

    let reply: unknown;
    if (this.#queue.length > 0) reply = this.#queue.shift();
    else if (this.#handler) reply = this.#handler;
    else throw new Error(`FakeLlm: no reply is scripted for call ${this.calls.length} (task ${req.task}).`);

    if (typeof reply === "function") reply = await (reply as FakeLlmHandler)(call);
    if (reply instanceof LlmError) throw reply;

    const parsed = req.schema.safeParse(reply);
    if (!parsed.success) {
      throw new LlmError("bad_output", `The model reply does not fit the schema: ${parsed.error.message.slice(0, 300)}`);
    }

    if (this.#usage) {
      this.#usage.add("llm_input_tokens", this.#callUsage.inputTokens);
      this.#usage.add("llm_output_tokens", this.#callUsage.outputTokens);
    }
    return { data: parsed.data, usage: { ...this.#callUsage }, model: this.#models[req.task] };
  }
}
