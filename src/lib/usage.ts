// The daily usage counters (table usage_daily) and their limits (§6.2).
// The day is the UTC day. The web process and the worker share the counters.
import { and, eq } from "drizzle-orm";

import type { UsageMeter } from "@/lib/connectors/types";
import { getDb, getSqlite } from "@/lib/db/client";
import { usageDaily } from "@/lib/db/schema";
import { ENV_DEFAULTS, type Env } from "@/lib/env";
import { nowMs, utcDay } from "@/lib/time";
import type { UsageMetric } from "@/lib/types";

/** The daily limit of a metric. Infinity = no limit. */
export function usageLimit(metric: UsageMetric, env: Env): number {
  switch (metric) {
    case "llm_calls":
      return env.llmMaxCallsPerDay;
    case "llm_calls_preview":
      return ENV_DEFAULTS.LLM_MAX_PREVIEW_CALLS_PER_DAY;
    case "x_posts":
      return env.xMaxPostsPerDay;
    case "web_searches":
      return env.webSearchMaxPerDay;
    default:
      return Infinity;
  }
}

function checkAmount(n: number): void {
  if (!Number.isInteger(n)) throw new RangeError("The usage amount must be a whole number.");
}

/**
 * A UsageMeter over the table usage_daily. Each method opens nothing at
 * creation time: it calls getDb() at the time of the call.
 */
export function createUsageMeter(env: Env): UsageMeter {
  const today = (metric: UsageMetric): number => {
    const row = getDb()
      .select({ value: usageDaily.value })
      .from(usageDaily)
      .where(and(eq(usageDaily.day, utcDay(nowMs())), eq(usageDaily.metric, metric)))
      .get();
    return row?.value ?? 0;
  };

  const add = (metric: UsageMetric, n: number): void => {
    checkAmount(n);
    getSqlite()
      .prepare(
        `INSERT INTO usage_daily (day, metric, value) VALUES (?, ?, ?)
         ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`,
      )
      .run(utcDay(nowMs()), metric, n);
  };

  return {
    take(metric, n) {
      checkAmount(n);
      if (n < 0) throw new RangeError("take() does not give usage back.");
      const limit = usageLimit(metric, env);
      if (limit === Infinity) {
        add(metric, n);
        return true;
      }
      // One statement: the test of the limit and the increment are atomic,
      // also when the web process and the worker call at the same moment.
      // The first row of the day is inserted only when n fits the limit; an
      // existing row is updated only when the sum fits the limit.
      const result = getSqlite()
        .prepare(
          `INSERT INTO usage_daily (day, metric, value)
           SELECT @day, @metric, @n WHERE @n <= @limit
           ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value
           WHERE usage_daily.value + excluded.value <= @limit`,
        )
        .run({ day: utcDay(nowMs()), metric, n, limit });
      return result.changes > 0;
    },
    add,
    remaining(metric) {
      const limit = usageLimit(metric, env);
      if (limit === Infinity) return Infinity;
      return Math.max(0, limit - today(metric));
    },
    today,
  };
}
