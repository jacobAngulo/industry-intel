// The status page, the state banners, and "Retry failed items"
// (specification §4.10, §13; §18.2 status.ts).
//
// The key and token facts come from the worker heartbeat (what the worker
// sees). The web environment is the fallback when the worker never ran.
import { credentialNeeds } from "@/lib/connectors/configs";
import { getSqlite } from "@/lib/db/client";
import { getEnv, hasModelKey } from "@/lib/env";
import { isWorkerAlive, readHeartbeat, readLlmPause } from "@/lib/pipeline/jobs";
import { nowMs } from "@/lib/time";
import { truncate } from "@/lib/text/words";
import { serverTimeZone, type SourceType, type UsageMetric, type WorkerHeartbeat } from "@/lib/types";
import { createUsageMeter, usageLimit } from "@/lib/usage";

import { logActivity } from "./activity";
import { workerEnvView } from "./_manage-source-rows";
import { loadFeedFacts, parseJson, requireName } from "./_read-shared";
import type { Actor, AppBanner, StatusReport } from "./types";

const STATUS_EVENTS = 50;
/** The source_errors banner names at most this many sources. */
const BANNER_SOURCE_NAMES = 2;
const BANNER_REASON_MAX = 80;

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

function workerFacts(now: number, beat: WorkerHeartbeat | null): StatusReport["worker"] {
  return {
    alive: isWorkerAlive(now, beat),
    lastBeatAt: beat?.at ?? null,
    hasModelKey: beat?.hasModelKey === true,
    hasXToken: beat?.hasXToken === true,
    hasMailbox: beat?.hasMailbox === true,
  };
}

function modelFacts(now: number): StatusReport["model"] {
  const env = getEnv();
  const usage = createUsageMeter(env);
  const pause = readLlmPause();
  return {
    judgeModel: env.ollamaModelJudge,
    analysisModel: env.ollamaModelAnalysis,
    pausedUntil: pause.pausedUntil !== null && pause.pausedUntil > now ? pause.pausedUntil : null,
    lastError: pause.lastError,
    callsToday: usage.today("llm_calls"),
    callLimit: usageLimit("llm_calls", env),
    previewCallsToday: usage.today("llm_calls_preview"),
    inputTokensToday: usage.today("llm_input_tokens"),
    outputTokensToday: usage.today("llm_output_tokens"),
  };
}

function counterFacts(metric: UsageMetric): { today: number; limit: number } {
  const env = getEnv();
  return { today: createUsageMeter(env).today(metric), limit: usageLimit(metric, env) };
}

/**
 * Queue sizes. `rejudgeQueued` is the re-judge work: the stories that the
 * open (queued or running) requests still have to do.
 */
function queueFacts(): StatusReport["queues"] {
  return getSqlite()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE judge_status = 'pending') AS itemsPending,
         (SELECT COUNT(*) FROM items WHERE judge_status = 'failed') AS itemsFailed,
         (SELECT COUNT(*) FROM analyses WHERE status = 'queued') AS analysesQueued,
         (SELECT COALESCE(SUM(MAX(0, total - done - failed)), 0) FROM rejudge_requests
           WHERE status IN ('queued', 'running')) AS rejudgeQueued`,
    )
    .get() as StatusReport["queues"];
}

/** Every unpaused source whose last check failed (a success clears last_error), the most failures first. */
function failingSources(): StatusReport["failingSources"] {
  return getSqlite()
    .prepare(
      `SELECT id, name, last_error AS lastError, next_check_at AS nextCheckAt, consecutive_failures AS consecutiveFailures
         FROM sources
        WHERE paused = 0 AND last_error IS NOT NULL
        ORDER BY consecutive_failures DESC, name ASC, id ASC`,
    )
    .all() as StatusReport["failingSources"];
}

function recentProblems(): StatusReport["events"] {
  return getSqlite()
    .prepare(
      `SELECT at, level, scope, message FROM events WHERE level IN ('warn', 'error')
        ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(STATUS_EVENTS) as StatusReport["events"];
}

export async function getStatus(): Promise<StatusReport> {
  const now = nowMs();
  const x = counterFacts("x_posts");
  const search = counterFacts("web_searches");
  return {
    worker: workerFacts(now, readHeartbeat()),
    model: modelFacts(now),
    x: { postsToday: x.today, postLimit: x.limit },
    webSearch: { searchesToday: search.today, limit: search.limit },
    queues: queueFacts(),
    failingSources: failingSources(),
    events: recentProblems(),
  };
}

// ---------------------------------------------------------------------------
// getBanners (§13)
// ---------------------------------------------------------------------------

const STATUS_LINK = { href: "/status", label: "Open the status page" };

/** "14:30", or "14:30 on 21 Nov" when the instant is on another local day than now. */
function clockText(instant: number, now: number, timeZone: string): string {
  const zone = safeTimeZone(timeZone);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(
    instant,
  );
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: zone });
  return day.format(instant) === day.format(now) ? time : `${time} on ${day.format(instant)}`;
}

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

function workerBanner(alive: boolean): AppBanner[] {
  if (alive) return [];
  return [
    {
      kind: "worker_down",
      tone: "warning",
      message: "The worker is not running, so nothing new arrives. Start the app with npm run dev or npm start.",
      link: STATUS_LINK,
    },
  ];
}

/** no_model_key, or else model_paused / budget_used (the daily limit wins: it is the more exact reason). */
function modelBanners(beat: WorkerHeartbeat | null, now: number, timeZone: string): AppBanner[] {
  const keyPresent = beat ? beat.hasModelKey : hasModelKey(getEnv());
  if (!keyPresent) {
    return [
      {
        kind: "no_model_key",
        tone: "warning",
        message:
          "The model key is missing. Save the Ollama API key in Settings → API keys (or set OLLAMA_API_KEY in .env). The worker still checks the sources; items wait for the model.",
      },
    ];
  }
  const env = getEnv();
  const usage = createUsageMeter(env);
  if (usage.remaining("llm_calls") <= 0) {
    const used = usage.today("llm_calls");
    const limit = usageLimit("llm_calls", env);
    return [
      {
        kind: "budget_used",
        tone: "warning",
        message: `The model call limit for today is used (${used} of ${limit}). Judging starts again tomorrow (UTC).`,
        link: STATUS_LINK,
      },
    ];
  }
  const pause = readLlmPause();
  if (pause.pausedUntil !== null && pause.pausedUntil > now) {
    const reason = pause.lastError ?? "a short pause after an error";
    return [
      {
        kind: "model_paused",
        tone: "info",
        message: `The model is not available now (${reason}). Judging starts again at ${clockText(pause.pausedUntil, now, timeZone)}.`,
        link: STATUS_LINK,
      },
    ];
  }
  return [];
}

interface FeedSourceFacts {
  id: number;
  name: string;
  type: SourceType;
  config: string;
  lastCheckedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/** The unpaused sources of a feed, the most failures first. */
function unpausedFeedSources(feedId: number): FeedSourceFacts[] {
  return getSqlite()
    .prepare(
      `SELECT s.id, s.name, s.type, s.config, s.last_checked_at AS lastCheckedAt, s.last_error AS lastError,
              s.consecutive_failures AS consecutiveFailures
         FROM sources s JOIN feed_sources fs ON fs.source_id = s.id
        WHERE fs.feed_id = ? AND s.paused = 0
        ORDER BY s.consecutive_failures DESC, s.name ASC, s.id ASC`,
    )
    .all(feedId) as FeedSourceFacts[];
}

/**
 * §13 first run: the feed has sources, no judgement yet, and a source waits
 * for its first check. A source that needs a missing credential (as the
 * worker sees it, like the badges of §10.2) does not wait: the worker never
 * checks it.
 */
function isFirstRun(feedId: number, beat: WorkerHeartbeat | null): boolean {
  const row = getSqlite()
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM feed_sources WHERE feed_id = @feedId) AS hasSources,
         EXISTS (SELECT 1 FROM judgements WHERE feed_id = @feedId) AS hasJudgements`,
    )
    .get({ feedId }) as { hasSources: number; hasJudgements: number };
  if (row.hasSources !== 1 || row.hasJudgements !== 0) return false;
  const env = workerEnvView(getEnv(), beat);
  return unpausedFeedSources(feedId).some(
    (source) => source.lastCheckedAt === null && credentialNeeds(source.type, env, parseJson(source.config)) === null,
  );
}

function firstRunBanner(feedId: number, beat: WorkerHeartbeat | null): AppBanner[] {
  if (!isFirstRun(feedId, beat)) return [];
  return [{ kind: "first_run", tone: "info", message: "The first checks run now. Stories show here in a few minutes." }];
}

/** The first sentence of a text, with no final full stop. */
function firstSentence(text: string): string {
  return text.trim().split(/\.\s/)[0]!.replace(/[.\s]+$/, "");
}

/** The short reason of a source problem, or null when the source has none. */
function sourceProblem(source: FeedSourceFacts, env: ReturnType<typeof workerEnvView>): string | null {
  const need = credentialNeeds(source.type, env, parseJson(source.config));
  if (need) {
    const text = firstSentence(need.message);
    return text.charAt(0).toLowerCase() + text.slice(1);
  }
  if (source.lastError !== null) return `the last check failed (${truncate(firstSentence(source.lastError), BANNER_REASON_MAX)})`;
  return null;
}

/** §13: the unpaused sources of the feed with a failed last check or a missing credential. */
function sourceErrorsBanner(feedId: number, beat: WorkerHeartbeat | null): AppBanner[] {
  const env = workerEnvView(getEnv(), beat);
  const problems = unpausedFeedSources(feedId).flatMap((source) => {
    const reason = sourceProblem(source, env);
    return reason === null ? [] : [{ id: source.id, text: `${source.name}: ${reason}` }];
  });
  if (problems.length === 0) return [];
  const named = problems.slice(0, BANNER_SOURCE_NAMES).map((p) => p.text);
  const more = problems.length - named.length;
  if (more > 0) named.push(`and ${more} more`);
  const count = problems.length === 1 ? "1 source of this feed has" : `${problems.length} sources of this feed have`;
  return [
    {
      kind: "source_errors",
      tone: "warning",
      message: `${count} a problem: ${named.join("; ")}.`,
      link:
        problems.length === 1
          ? { href: `/sources/${problems[0]!.id}`, label: "Open the source" }
          : { href: `/sources?feed=${feedId}`, label: "Open the sources" },
    },
  ];
}

/**
 * The state banners that apply now. Without `feedId`: the banners of every
 * page and of the status page (worker, model). With `feedId`: also the
 * banners of a feed page (first run, source errors). Times show in the time
 * zone of the feed (its digest setting), else of the server.
 */
export async function getBanners(feedId?: number): Promise<AppBanner[]> {
  const now = nowMs();
  const beat = readHeartbeat();
  const feed = feedId === undefined ? null : loadFeedFacts(feedId);
  const banners = [
    ...workerBanner(isWorkerAlive(now, beat)),
    ...modelBanners(beat, now, feed?.timeZone ?? serverTimeZone()),
  ];
  if (feed) banners.push(...firstRunBanner(feed.id, beat), ...sourceErrorsBanner(feed.id, beat));
  return banners;
}

// ---------------------------------------------------------------------------
// retryFailedItems
// ---------------------------------------------------------------------------

/** Sets `failed` items back to `pending` with attempts 0. Returns the count. Needs a display name. */
export async function retryFailedItems(actor: Actor): Promise<number> {
  const name = requireName(actor);
  const sqlite = getSqlite();
  return sqlite
    .transaction(() => {
      const result = sqlite
        .prepare(
          `UPDATE items
              SET judge_status = 'pending', judge_attempts = 0, judge_error = NULL, next_judge_at = NULL,
                  judge_locked_until = NULL
            WHERE judge_status = 'failed'`,
        )
        .run();
      if (result.changes > 0) {
        logActivity(
          { ...actor, name },
          "retry_failed_items",
          "item",
          null,
          `Put ${result.changes} failed ${result.changes === 1 ? "item" : "items"} back in the queue for the model`,
        );
      }
      return result.changes;
    })
    .immediate();
}
