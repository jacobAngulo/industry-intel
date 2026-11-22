import { z } from "zod";

import { unauthorized, verifyAdminToken } from "@/lib/admin-auth";
import { decideAccessRequest, isServiceError } from "@/lib/services";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ decision: z.enum(["approve", "deny"]), operator: z.string().nullish() });

/** Approves or denies one access request (Ops Console). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!verifyAdminToken(request)) return unauthorized();
  const { id } = await params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "decision must be 'approve' or 'deny'" }, { status: 400 });
  try {
    return Response.json(decideAccessRequest(id, body.data.decision, body.data.operator ?? null));
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return Response.json({ error: "unknown access request" }, { status: 404 });
    }
    throw error;
  }
}
