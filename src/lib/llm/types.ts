// The model contract of specification §11.3 (the kinds follow §20).
import type { z } from "zod";

export type LlmTask = "judge" | "analysis";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface LlmJsonRequest<T> {
  task: LlmTask;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  usageMetric?: "llm_calls" | "llm_calls_preview";
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmJsonResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  /** True when the key is present. */
  available(): boolean;
  modelFor(task: LlmTask): string;
  json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>>;
}

export type LlmErrorKind =
  | "auth"
  | "payment"
  | "not_found"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "bad_output"
  | "bad_request"
  | "network"
  | "budget"
  | "no_key";

/** Service errors: they pause the model and do not count as an attempt of the item (§7.3). */
export const LLM_SERVICE_ERROR_KINDS: readonly LlmErrorKind[] = [
  "rate_limited",
  "overloaded",
  "network",
  "auth",
  "payment",
  "not_found",
  "budget",
  "no_key",
];

/** Item errors: they count as an attempt of the item (§7.3). */
export const LLM_ITEM_ERROR_KINDS: readonly LlmErrorKind[] = ["bad_output", "bad_request", "timeout"];

export class LlmError extends Error {
  kind: LlmErrorKind;
  retryAfterMs?: number;

  constructor(kind: LlmErrorKind, message: string, options?: { retryAfterMs?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmError";
    this.kind = kind;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchProvider {
  search(q: { query: string; maxResults: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}
