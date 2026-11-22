import { unauthorized, verifyAdminToken } from "@/lib/admin-auth";
import { accessSummary } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The people and the pending access requests, for Ops Console. Read-only. */
export function GET(request: Request): Response {
  if (!verifyAdminToken(request)) return unauthorized();
  return Response.json(accessSummary());
}
