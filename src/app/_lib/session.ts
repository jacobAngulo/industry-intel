// The session cookie: who signed in. It says nothing about the access.
import { getToken } from "next-auth/jwt";

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Without all three values nobody can sign in, and the gate refuses every page. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET && process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

/** The account id of a valid session cookie, or null. */
export async function sessionUserId(headers: Headers): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const token = await getToken({ req: { headers }, secret, secureCookie: secureCookies() });
  return typeof token?.sub === "string" && token.sub ? token.sub : null;
}
