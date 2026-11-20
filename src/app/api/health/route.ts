import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { workerState } from "@/lib/db/schema";

// A route handler is not below the root layout. It sets the option itself.
export const dynamic = "force-dynamic";

/** JSON health: `worker` is the heartbeat row of worker_state, or null when the worker never ran. */
export function GET(): Response {
  const time = new Date().toISOString();
  try {
    const worker = getDb().select().from(workerState).where(eq(workerState.key, "heartbeat")).get() ?? null;
    return Response.json({ ok: true, time, worker });
  } catch (error) {
    console.error("[health] database read failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ ok: false, time, worker: null }, { status: 503 });
  }
}
