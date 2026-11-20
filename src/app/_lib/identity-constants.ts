// Names and rules of the identity cookies (specification §15). Pure: the proxy,
// the server code, and the tests import it.

/** The id of the browser (random UUID, httpOnly). Set by src/proxy.ts. */
export const CLIENT_COOKIE = "ii_client";
/** The display name (httpOnly; the server passes it to client components as a prop). */
export const NAME_COOKIE = "ii_name";
/** The request header that carries the client id from the proxy to the page (first request). */
export const CLIENT_HEADER = "x-ii-client";
/** One year, in seconds. */
export const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** The longest display name. */
export const NAME_MAX_LENGTH = 60;
/** The name of the actor for a vote when no display name is set (§18.1). */
export const ANONYMOUS_NAME = "Someone";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a value that the proxy can have written (a UUID). */
export function isValidClientId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Cleans a display name: removes control and invisible characters, joins
 * white space, trims. Returns null when the result is empty or too long.
 */
export function cleanDisplayName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    // Control characters, zero-width and bidirectional marks, BOM.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || cleaned.length > NAME_MAX_LENGTH) return null;
  return cleaned;
}
