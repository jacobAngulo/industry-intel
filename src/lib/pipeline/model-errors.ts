// The model pause of §7.3. A service error (the model service, the account,
// or the budget) pauses all model calls; an item error counts against the
// one item (or analysis, or re-judge story) only.
import { LLM_SERVICE_ERROR_KINDS, LlmError, type LlmErrorKind } from "@/lib/llm/types";
import { logEvent } from "@/lib/log";
import { MINUTE_MS, nextUtcMidnight } from "@/lib/time";

import { clearLlmPause, readLlmPause, setLlmPause } from "./jobs";

/** Short plain reasons for the banner "The model is not available now (<reason>)". */
const REASONS: Record<LlmErrorKind, string> = {
  overloaded: "the model service is overloaded",
  network: "the model service cannot be reached",
  rate_limited: "the model service limits the request rate",
  auth: "the model key was refused",
  payment: "the model account has no credits",
  not_found: "no usable model was found",
  budget: "the daily model call limit is used",
  no_key: "the model key is missing",
  timeout: "the model did not answer in time",
  bad_output: "the model reply was not valid",
  bad_request: "the model service refused the request",
};

/** A pause that doubles with each failure in a row, from `base` up to `max`. */
const DOUBLING: Partial<Record<LlmErrorKind, { base: number; max: number }>> = {
  overloaded: { base: 2 * MINUTE_MS, max: 30 * MINUTE_MS },
  network: { base: 2 * MINUTE_MS, max: 30 * MINUTE_MS },
  rate_limited: { base: 10 * MINUTE_MS, max: 60 * MINUTE_MS },
};
const ACCOUNT_PAUSE_MS = 60 * MINUTE_MS;
export const TIMEOUT_PAUSE_MS = 2 * MINUTE_MS;

/** A thrown value as an LlmError. Anything else from the provider counts as a bad reply of this item. */
export function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const detail = error instanceof Error ? error.message : "unknown error";
  return new LlmError("bad_output", `The model call failed: ${detail}`.slice(0, 300));
}

export function isServiceError(error: LlmError): boolean {
  return LLM_SERVICE_ERROR_KINDS.includes(error.kind);
}

/**
 * Sets the model pause for a service error (§7.3 failure handling). While a
 * pause is active, more failures of the same outage (calls that were in
 * flight) do not raise the step again: they keep the later end time.
 */
export function pauseForServiceError(error: LlmError, now: number): void {
  const current = readLlmPause();
  const active = current.pausedUntil !== null && current.pausedUntil > now;
  const doubling = DOUBLING[error.kind];
  let until: number;
  let step = current.step;
  if (doubling) {
    const index = active ? Math.max(0, current.step - 1) : current.step;
    until = now + Math.min(doubling.base * 2 ** index, doubling.max);
    if (error.kind === "rate_limited" && error.retryAfterMs !== undefined) {
      until = Math.max(until, now + error.retryAfterMs);
    }
    if (!active) step += 1;
  } else if (error.kind === "budget") {
    until = nextUtcMidnight(now);
  } else {
    until = now + ACCOUNT_PAUSE_MS;
  }
  let lastError = REASONS[error.kind];
  if (active && current.pausedUntil !== null && current.pausedUntil >= until) {
    until = current.pausedUntil;
    lastError = current.lastError ?? lastError;
  }
  setLlmPause({ until, step, lastError }, now);
  if (error.kind === "auth" || error.kind === "payment" || error.kind === "not_found") {
    logEvent("error", "model", `Model calls are paused for 60 minutes: ${REASONS[error.kind]}.`, { kind: error.kind });
  }
}

/** A timeout counts against the item, and it also pauses the model for 2 minutes. */
export function pauseForTimeout(now: number): void {
  const current = readLlmPause();
  const until = Math.max(current.pausedUntil ?? 0, now + TIMEOUT_PAUSE_MS);
  setLlmPause({ until, step: current.step, lastError: REASONS.timeout }, now);
}

/**
 * After a successful call: no pause, step 0, no last error (written only when
 * something is set). A pause that is still active stays as it is: a call that
 * was in flight when a service error set the pause does not prove that the
 * service is well again.
 */
export function noteModelSuccess(now: number): void {
  const current = readLlmPause();
  if (current.pausedUntil !== null && current.pausedUntil > now) return;
  if (current.pausedUntil !== null || current.step !== 0 || current.lastError !== null) clearLlmPause(now);
}

/**
 * The shared part of the failure handling: a service error sets the pause and
 * returns "service"; an item error (a timeout also pauses) returns "item".
 */
export function notePauseFor(error: LlmError, now: number): "service" | "item" {
  if (isServiceError(error)) {
    pauseForServiceError(error, now);
    return "service";
  }
  if (error.kind === "timeout") pauseForTimeout(now);
  return "item";
}
