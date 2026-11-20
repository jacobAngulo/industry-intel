// The mapping from an HTTP result of the Ollama cloud API to an LlmError
// (specification §20). No message holds the key: `safeText` removes it from
// each text that comes from the server.
import { HttpError } from "@/lib/http/types";
import { nowMs } from "@/lib/time";

import { LlmError } from "./types";

const MAX_DETAIL = 200;
/** A larger Retry-After value is not believable: the pause logic of the pipeline has its own steps. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** One line, at most `max` characters, with each occurrence of the key removed. */
export function safeText(text: string, key: string | undefined, max: number = MAX_DETAIL): string {
  let out = text;
  if (key) out = out.split(key).join("[key]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * The text of an error body. The native shape is `{"error": "<text>"}`; the
 * Content-Type can be text/plain, so the body is always read as text.
 */
export function errorBodyText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && "message" in value) {
        const message = (value as { message: unknown }).message;
        if (typeof message === "string") return message;
      }
    }
  } catch {
    // Not JSON: use the raw text.
  }
  return body;
}

/** A Retry-After header (seconds or an HTTP date) in milliseconds. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const date = Date.parse(text);
    if (Number.isNaN(date)) return undefined;
    ms = date - nowMs();
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

export interface StatusErrorInput {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** The start of the message, for example "The model service" or "The web search". */
  what: string;
  key: string | undefined;
}

/** The LlmError for a response whose status is not 2xx. */
export function errorForStatus(input: StatusErrorInput): LlmError {
  const { status, what, key } = input;
  const detail = safeText(errorBodyText(input.body), key);
  const tail = detail ? ` (HTTP ${status}: ${detail})` : ` (HTTP ${status})`;

  if (status === 401 || status === 403) return new LlmError("auth", `${what} refused the key${tail}.`);
  if (status === 402) return new LlmError("payment", `${what} needs payment or credits${tail}.`);
  if (status === 404) return new LlmError("not_found", `${what} did not find the model or the address${tail}.`);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(input.headers["retry-after"]);
    return new LlmError(
      "rate_limited",
      `${what} limits the request rate${tail}.`,
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  }
  if (status === 408) return new LlmError("timeout", `${what} reached its time limit${tail}.`);
  if (status >= 500) return new LlmError("overloaded", `${what} is not available now${tail}.`);
  if (status >= 400) return new LlmError("bad_request", `${what} refused the request${tail}.`);
  // 1xx and 3xx: SafeHttp follows redirects, so this is not a usable answer.
  return new LlmError("network", `${what} gave an unexpected answer${tail}.`);
}

/** The LlmError for an error that the HTTP client threw. */
export function errorForThrown(error: unknown, what: string, key: string | undefined): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof HttpError) {
    if (error.kind === "timeout") {
      return new LlmError("timeout", `${what} did not answer in the time limit.`, { cause: error });
    }
    if (error.kind === "too_large") {
      return new LlmError("bad_output", `${what} sent a reply that is too large.`, { cause: error });
    }
    return new LlmError("network", `${what} was not reachable (${error.kind}).`, { cause: error });
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new LlmError("timeout", `${what} did not answer in the time limit.`, { cause: error });
  }
  const detail = error instanceof Error ? safeText(error.message, key) : "";
  return new LlmError("network", `${what} was not reachable${detail ? ` (${detail})` : ""}.`, { cause: error });
}
