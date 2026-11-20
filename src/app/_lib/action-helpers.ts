// Helpers for the Server Actions of all pages (specification §18). They are
// plain functions, not Server Actions: a "use server" file may export only
// async functions, so they live here. Import them in your `actions.ts`.
import type { z } from "zod";

import type { ActionResult, Actor } from "@/lib/services/types";

import { requireActor } from "./identity";

type FailCode = NonNullable<Extract<ActionResult, { ok: false }>["code"]>;

/** A success result. */
export function ok<T>(data: T, message?: string): ActionResult<T> {
  return message === undefined ? { ok: true, data } : { ok: true, data, message };
}

/** A failure result. */
export function fail(message: string, code?: FailCode, fieldErrors?: Record<string, string>): ActionResult<never> {
  const result: Extract<ActionResult<never>, { ok: false }> = { ok: false, message };
  if (code !== undefined) result.code = code;
  if (fieldErrors !== undefined && Object.keys(fieldErrors).length > 0) result.fieldErrors = fieldErrors;
  return result;
}

/** The message of the `needs_name` result. */
export const NEEDS_NAME_MESSAGE = "Set your name first. Your name shows next to the things that you add or change.";

/** True when an action result asks for a display name. */
export function isNeedsName(result: ActionResult<unknown>): boolean {
  return !result.ok && result.code === "needs_name";
}

/**
 * FormData to a plain object for zod. Text values only (files are dropped), and
 * the hidden fields of Next.js (`$ACTION_…`) are dropped. A key that occurs more
 * than once becomes an array. The keys in `arrays` are always arrays (for
 * example a group of checkboxes with zero or one value checked).
 */
export function formToObject(
  formData: FormData,
  opts: { arrays?: readonly string[] } = {},
): Record<string, string | string[]> {
  const arrays = new Set(opts.arrays ?? []);
  const out: Record<string, string | string[]> = {};
  for (const key of arrays) out[key] = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (key.startsWith("$ACTION")) continue;
    const current = out[key];
    if (current === undefined) {
      out[key] = arrays.has(key) ? [value] : value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      out[key] = [current, value];
    }
  }
  return out;
}

/**
 * The field errors of a zod error: the first message for each path. The key
 * is the path joined with "." (for example "digest.time"); "_form" for an error with no path.
 */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** The message of a validation failure. */
export const VALIDATION_MESSAGE = "Some fields are not valid. Correct the marked fields and try again.";

/** Validates a value with a zod schema: `ok(data)` or `fail(..., "validation", fieldErrors)`. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): ActionResult<z.output<S>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  const fieldErrors = zodFieldErrors(parsed.error);
  const formError = fieldErrors._form;
  return fail(formError && Object.keys(fieldErrors).length === 1 ? formError : VALIDATION_MESSAGE, "validation", fieldErrors);
}

/** `formToObject` and then `parseInput`. */
export function parseForm<S extends z.ZodType>(
  schema: S,
  formData: FormData,
  opts: { arrays?: readonly string[] } = {},
): ActionResult<z.output<S>> {
  return parseInput(schema, formToObject(formData, opts));
}

/**
 * Runs `fn` with the actor of the request. With `needsName` (every change
 * except a vote) and no display name, it returns `{ ok: false, code: "needs_name" }`
 * and does not call `fn`. Without `needsName` the name falls back to "Someone".
 */
export async function withActor<T>(
  opts: { needsName: boolean },
  fn: (actor: Actor) => Promise<ActionResult<T>> | ActionResult<T>,
): Promise<ActionResult<T>> {
  const actor = await requireActor(opts.needsName);
  if (!actor) return fail(NEEDS_NAME_MESSAGE, "needs_name");
  return fn(actor);
}
