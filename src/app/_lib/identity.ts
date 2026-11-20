// Identity of the person who makes a request (specification §15). Server only.
// It only reads: the proxy (src/proxy.ts) writes `ii_client`, and the Server
// Action setName writes `ii_name`.
import { cookies, headers } from "next/headers";

import type { Actor } from "@/lib/services/types";

import {
  ANONYMOUS_NAME,
  CLIENT_COOKIE,
  CLIENT_HEADER,
  NAME_COOKIE,
  cleanDisplayName,
  isValidClientId,
} from "./identity-constants";

/** The display name (or null) and the browser id of the current request. Never writes. */
export async function getActor(): Promise<{ name: string | null; clientId: string }> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const fromCookie = cookieStore.get(CLIENT_COOKIE)?.value;
  const fromHeader = headerStore.get(CLIENT_HEADER);
  // The proxy sets the header on every request (from the cookie, or a new id
  // on the first request). The cookie is the fallback for a path outside the proxy matcher.
  const clientId = isValidClientId(fromHeader) ? fromHeader : isValidClientId(fromCookie) ? fromCookie : "";
  const name = cleanDisplayName(cookieStore.get(NAME_COOKIE)?.value);
  return { name, clientId };
}

/**
 * The actor for a mutation. With `needsName` (every change except a vote) it
 * returns null when no display name is set; the caller answers `needs_name`.
 * Without it, a missing name becomes "Someone" (§18.1).
 */
export async function requireActor(needsName: boolean): Promise<Actor | null> {
  const { name, clientId } = await getActor();
  if (name) return { name, clientId };
  if (needsName) return null;
  return { name: ANONYMOUS_NAME, clientId };
}
