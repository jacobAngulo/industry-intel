import { createHash, timingSafeEqual } from "node:crypto";

// Both sides become 32 bytes: timingSafeEqual throws on a length mismatch, and
// that would show the expected length.
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * The bearer guard of /api/admin, which Ops Console calls on loopback. nginx
 * does not route it, but the guard does not depend on that. An unset or short
 * token closes the surface.
 */
export function verifyAdminToken(request: Request): boolean {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected || expected.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(expected));
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
