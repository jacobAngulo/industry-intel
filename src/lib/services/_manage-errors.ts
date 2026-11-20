// The error pattern of the services (see the comment in ./index.ts).
//
// A service function validates its input with zod even though the Server
// Action validated it already: the services are the last line before the
// database. A bad input, a missing row, a conflict, or a cap throws a
// ServiceError. Any other error is a bug or an infrastructure failure.
import type { z } from "zod";

import type { ActionResult, Actor } from "./types";

export type ServiceErrorCode = NonNullable<Extract<ActionResult, { ok: false }>["code"]>;

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly fieldErrors?: Record<string, string>;

  constructor(code: ServiceErrorCode, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    if (fieldErrors && Object.keys(fieldErrors).length > 0) this.fieldErrors = fieldErrors;
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}

/**
 * For a Server Action: the failure result of a ServiceError. Any other error
 * is thrown again (Next.js shows the error page).
 */
export function serviceFailure(error: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (!isServiceError(error)) throw error;
  const result: Extract<ActionResult<never>, { ok: false }> = { ok: false, message: error.message, code: error.code };
  if (error.fieldErrors) result.fieldErrors = error.fieldErrors;
  return result;
}

const VALIDATION_MESSAGE = "Some fields are not valid. Correct the marked fields and try again.";

/** The first message for each path of a zod error ("_form" for an error with no path). */
export function fieldErrorsOf(error: z.ZodError, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    const key = [prefix, path].filter(Boolean).join(".") || "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Parses a value with a zod schema, or throws a ServiceError with the code `validation`. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, prefix = ""): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fieldErrors = fieldErrorsOf(parsed.error, prefix);
  const keys = Object.keys(fieldErrors);
  const message = keys.length === 1 ? `${keys[0] === "_form" ? "" : `${keys[0]}: `}${fieldErrors[keys[0]!]}` : VALIDATION_MESSAGE;
  throw new ServiceError("validation", message, fieldErrors);
}

export function notFound(what: string): ServiceError {
  return new ServiceError("not_found", `${what} does not exist.`);
}

const ANONYMOUS_NAME = "someone";

/**
 * Every change except a vote needs a display name (§15). The Server Action
 * checks it first; this check keeps the services safe for other callers.
 */
export function requireName(actor: Actor): void {
  const name = typeof actor?.name === "string" ? actor.name.trim() : "";
  if (!name || name.toLowerCase() === ANONYMOUS_NAME) {
    throw new ServiceError("needs_name", "Set your name first. Your name shows next to the things that you add or change.");
  }
}
