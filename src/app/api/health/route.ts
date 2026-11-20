import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { workerState } from "@/lib/db/schema";
import { isWorkerAlive, readHeartbeat } from "@/lib/pipeline/jobs";
import { nowMs } from "@/lib/time";

import packageJson from "../../../../package.json";

// A route handler is not below the root layout. It sets the option itself.
export const dynamic = "force-dynamic";

const STARTED_AT = new Date();

type CheckStatus = "ok" | "degraded" | "fail";
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

const RANK: Record<CheckStatus, number> = { ok: 0, degraded: 1, fail: 2 };

/**
 * JSON health in the envelope of the VPS deployment standard (`status`, `slug`,
 * `version`, `started_at`, `uptime_s`, `checks`), plus the original fields
 * (`ok`, `time`, `worker`: the heartbeat row of worker_state, or null when the
 * worker never ran). `status` is the worst check. A stopped worker is
 * `degraded`, not `fail`: the web app still serves the stored stories.
 */
export function GET(): Response {
  const now = new Date();
  const checks: Check[] = [];
  let worker: unknown = null;
  try {
    worker = getDb().select().from(workerState).where(eq(workerState.key, "heartbeat")).get() ?? null;
    checks.push({ name: "db", status: "ok", detail: "SQLite readable" });
    const beat = readHeartbeat();
    if (isWorkerAlive(nowMs(), beat)) {
      checks.push({ name: "worker", status: "ok", detail: "heartbeat is fresh" });
    } else {
      const detail = beat ? `last heartbeat ${new Date(beat.at).toISOString()}` : "the worker never ran";
      checks.push({ name: "worker", status: "degraded", detail });
    }
  } catch (error) {
    console.error("[health] database read failed:", error instanceof Error ? error.message : "unknown error");
    checks.push({ name: "db", status: "fail", detail: "database read failed" });
  }
  const status = checks.reduce<CheckStatus>((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), "ok");
  return Response.json(
    {
      status,
      slug: "industry-intel",
      version: packageJson.version,
      started_at: STARTED_AT.toISOString(),
      uptime_s: Math.round((now.getTime() - STARTED_AT.getTime()) / 1000),
      checks,
      ok: status !== "fail",
      time: now.toISOString(),
      worker,
    },
    { status: status === "fail" ? 503 : 200 },
  );
}
