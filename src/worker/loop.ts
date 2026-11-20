// The worker loop (specification §7.1).
//
// One tick each 5 s (each 1 s while there is work, so that a backlog drains
// fast). A tick writes the heartbeat, starts the jobs of each stage up to the
// limit of that stage, and returns at once: it never waits for a job. The
// loop keeps the ids of the jobs in flight in memory, so that a tick never
// starts a second job for the same source or item.
//
// main.ts wires the real functions. Tests pass fakes and call tick() by hand.
import { logEvent } from "@/lib/log";
import type { ModelGate, PipelineDeps } from "@/lib/pipeline";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "@/lib/time";

export interface CheckResult {
  ran: boolean;
  ok: boolean;
  itemsFound: number;
  itemsNew: number;
  error?: string;
}

export type JudgeOutcome = "judged" | "joined" | "regroup" | "retry" | "failed" | "skipped" | "paused";

/** The functions that the loop runs. The signatures are those of "@/lib/pipeline" and "@/lib/digests". */
export interface WorkerJobs {
  dueSourceIds(limit: number, now: number): number[];
  checkSource(sourceId: number, deps: PipelineDeps): Promise<CheckResult>;
  modelGate(now: number): ModelGate;
  claimItemsToJudge(limit: number, inFlightItemIds: number[], now: number): number[];
  judgeItem(itemId: number, deps: PipelineDeps): Promise<{ outcome: JudgeOutcome }>;
  runNextAnalysis(deps: PipelineDeps): Promise<boolean>;
  runRejudgeStep(deps: PipelineDeps): Promise<boolean>;
  createDueDigests(now: number): number;
  housekeeping(now: number): void;
}

export const WORKER_TIMING = {
  /** The pause between two ticks when nothing happened. */
  idleTickMs: 5 * SECOND_MS,
  /** The pause between two ticks after a tick with work. */
  busyTickMs: 1 * SECOND_MS,
  digestEveryMs: 1 * MINUTE_MS,
  housekeepingEveryMs: 1 * HOUR_MS,
  /** The first housekeeping runs this long after the start. */
  housekeepingFirstMs: 1 * MINUTE_MS,
  summaryEveryMs: 1 * MINUTE_MS,
  maxChecks: 4,
  maxJudges: 3,
  maxAnalyses: 1,
  maxRejudges: 1,
} as const;

export type WorkerTiming = { [K in keyof typeof WORKER_TIMING]: number };

/** The clean stop waits at most this long for the jobs in flight. */
export const STOP_TIMEOUT_MS = 5 * SECOND_MS;

/** The same error of the same stage is logged at most one time in this period. */
const ERROR_REPEAT_MS = 1 * MINUTE_MS;
const MAX_ERROR_TEXT = 300;

type Stage = "heartbeat" | "checks" | "model gate" | "judge" | "analysis" | "re-judge" | "digests" | "housekeeping";

type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export interface WorkerOptions {
  jobs: WorkerJobs;
  deps: PipelineDeps;
  /** The clock of the loop. */
  now: () => number;
  /** Writes the heartbeat and renews the lease. Returns false when another worker holds the lease now. */
  heartbeat: (now: number) => boolean;
  /** Called one time when heartbeat() returns false. The loop starts no new work after that. */
  onLeaseLost?: () => void;
  timing?: Partial<WorkerTiming>;
  /** One console line. Default: console.log. */
  log?: (line: string) => void;
  /** Stores an error. Default: logEvent("error", "worker", ...). */
  reportError?: (message: string, data: Record<string, unknown>) => void;
  /** Values that must never appear in a log line (the keys and tokens of the environment). */
  secrets?: () => ReadonlyArray<string | undefined>;
  timers?: Timers;
}

export interface TickResult {
  didWork: boolean;
  nextDelayMs: number;
}

export interface InFlight {
  sourceIds: number[];
  itemIds: number[];
  analysis: boolean;
  rejudge: boolean;
}

export interface Worker {
  start(): void;
  /** Starts no new work and waits at most `timeoutMs` for the jobs in flight. */
  stop(timeoutMs?: number): Promise<{ finished: boolean; unfinished: number }>;
  tick(): TickResult;
  inFlight(): InFlight;
  /** Resolves when no job is in flight (tests). */
  settle(): Promise<void>;
}

interface Counters {
  checks: number;
  judged: number;
  failed: number;
  analyses: number;
  rejudgeSteps: number;
}

const OUTCOME_WORDS: Record<JudgeOutcome, string> = {
  judged: "judged",
  joined: "joined a story",
  regroup: "waits for a new story",
  retry: "will be tried again",
  failed: "failed",
  skipped: "skipped",
  paused: "waits (the model is paused)",
};

function emptyCounters(): Counters {
  return { checks: 0, judged: 0, failed: 0, analyses: 0, rejudgeSteps: 0 };
}

/** One line of text with no secret value, fit for a log line. */
export function describeError(error: unknown, secrets: ReadonlyArray<string | undefined> = []): string {
  let text = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  for (const secret of secrets) {
    // A very short value would hide normal words; the real keys are long.
    if (secret && secret.length >= 6) text = text.split(secret).join("[hidden]");
  }
  text = text.replace(/\s+/g, " ").trim() || "unknown error";
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text;
}

function gateWords(gate: ModelGate | null): string {
  if (!gate) return "unknown";
  if (gate.open) return "open";
  if (gate.reason === "no_key") return "no key";
  if (gate.reason === "budget") return "daily limit used";
  return gate.until ? `paused until ${new Date(gate.until).toISOString()}` : "paused";
}

/** Calls `work` and turns a synchronous throw into a rejected promise. */
function startJob<T>(work: () => Promise<T>): Promise<T> {
  try {
    return work();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createWorker(options: WorkerOptions): Worker {
  const { jobs, deps } = options;
  const timing: WorkerTiming = { ...WORKER_TIMING, ...options.timing };
  const log = options.log ?? ((line: string) => console.log(line));
  const reportError =
    options.reportError ?? ((message: string, data: Record<string, unknown>) => logEvent("error", "worker", message, data));
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const sourcesInFlight = new Set<number>();
  const itemsInFlight = new Set<number>();
  let analysisInFlight = false;
  let rejudgeInFlight = false;
  const running = new Set<Promise<unknown>>();

  let started = false;
  let stopping = false;
  let leaseLost = false;
  let timer: unknown = null;
  let workSinceLastTick = false;
  let counters = emptyCounters();

  let nextDigestAt: number | null = null;
  let nextHousekeepingAt: number | null = null;
  let nextSummaryAt: number | null = null;
  const lastErrors = new Map<Stage, { text: string; at: number }>();

  function clean(error: unknown): string {
    return describeError(error, options.secrets?.() ?? []);
  }

  function fail(stage: Stage, error: unknown, data: Record<string, unknown> = {}): void {
    const text = clean(error);
    const at = options.now();
    const last = lastErrors.get(stage);
    if (last && last.text === text && at - last.at < ERROR_REPEAT_MS) return;
    lastErrors.set(stage, { text, at });
    try {
      reportError(`The ${stage} stage failed: ${text}`, { stage, ...data });
    } catch {
      // The error log itself failed (for example, the database is closed). Keep the loop alive.
    }
  }

  function track<T>(
    stage: Stage,
    data: Record<string, unknown>,
    work: () => Promise<T>,
    onResult: (result: T) => void,
    release: () => void,
  ): void {
    const job = startJob(work)
      .then(onResult, (error: unknown) => {
        counters.failed += 1;
        fail(stage, error, data);
      })
      .catch((error: unknown) => fail(stage, error, data))
      .finally(() => {
        release();
        running.delete(job);
      });
    running.add(job);
  }

  function onCheckDone(sourceId: number, result: CheckResult): void {
    if (!result.ran) {
      log(`[worker] source ${sourceId} not checked: ${clean(result.error ?? "a credential or a setting is missing")}`);
      return;
    }
    workSinceLastTick = true;
    counters.checks += 1;
    if (result.ok) {
      log(`[worker] source ${sourceId} checked: ${result.itemsFound} found, ${result.itemsNew} new`);
    } else {
      counters.failed += 1;
      log(`[worker] source ${sourceId} check failed: ${clean(result.error ?? "unknown error")}`);
    }
  }

  function onJudgeDone(itemId: number, outcome: JudgeOutcome): void {
    if (outcome !== "paused") workSinceLastTick = true;
    if (outcome === "judged" || outcome === "joined") counters.judged += 1;
    if (outcome === "failed") counters.failed += 1;
    log(`[worker] item ${itemId}: ${OUTCOME_WORDS[outcome] ?? outcome}`);
  }

  /** Stage 2. Returns the number of checks started. */
  function startChecks(now: number): number {
    const free = timing.maxChecks - sourcesInFlight.size;
    if (free <= 0) return 0;
    let ids: number[];
    try {
      ids = jobs.dueSourceIds(free, now).filter((id) => !sourcesInFlight.has(id)).slice(0, free);
    } catch (error) {
      fail("checks", error);
      return 0;
    }
    for (const sourceId of ids) {
      sourcesInFlight.add(sourceId);
      track(
        "checks",
        { sourceId },
        () => jobs.checkSource(sourceId, deps),
        (result) => onCheckDone(sourceId, result),
        () => sourcesInFlight.delete(sourceId),
      );
    }
    return ids.length;
  }

  function readGate(now: number): ModelGate | null {
    try {
      return jobs.modelGate(now);
    } catch (error) {
      fail("model gate", error);
      return null;
    }
  }

  /** Stage 3. Returns the number of items claimed. */
  function startJudges(now: number): number {
    const free = timing.maxJudges - itemsInFlight.size;
    if (free <= 0) return 0;
    let ids: number[];
    try {
      ids = jobs
        .claimItemsToJudge(free, [...itemsInFlight], now)
        .filter((id) => !itemsInFlight.has(id))
        .slice(0, free);
    } catch (error) {
      fail("judge", error);
      return 0;
    }
    for (const itemId of ids) {
      itemsInFlight.add(itemId);
      track(
        "judge",
        { itemId },
        () => jobs.judgeItem(itemId, deps),
        (result) => onJudgeDone(itemId, result.outcome),
        () => itemsInFlight.delete(itemId),
      );
    }
    return ids.length;
  }

  /** Stage 4: one analysis at a time. */
  function startAnalysis(): void {
    if (analysisInFlight) return;
    analysisInFlight = true;
    track(
      "analysis",
      {},
      () => jobs.runNextAnalysis(deps),
      (didWork) => {
        if (!didWork) return;
        workSinceLastTick = true;
        counters.analyses += 1;
      },
      () => {
        analysisInFlight = false;
      },
    );
  }

  /** Stage 5: one re-judge step at a time. */
  function startRejudge(): void {
    if (rejudgeInFlight) return;
    rejudgeInFlight = true;
    track(
      "re-judge",
      {},
      () => jobs.runRejudgeStep(deps),
      (didWork) => {
        if (!didWork) return;
        workSinceLastTick = true;
        counters.rejudgeSteps += 1;
      },
      () => {
        rejudgeInFlight = false;
      },
    );
  }

  /** Stages 3 to 5. Returns the number of items claimed. */
  function startModelWork(now: number, gate: ModelGate | null): number {
    if (!gate?.open) return 0;
    const claimed = startJudges(now);
    startAnalysis();
    // The re-judge waits while new items wait for the model (§7.1 step 5).
    if (claimed === 0 && itemsInFlight.size === 0) startRejudge();
    return claimed;
  }

  /** Stages 6 and 7, on their own timers. A failure still moves the timer, so a broken stage does not run each tick. */
  function runTimedStages(now: number): void {
    if (nextDigestAt !== null && now >= nextDigestAt) {
      nextDigestAt = now + timing.digestEveryMs;
      try {
        jobs.createDueDigests(now);
      } catch (error) {
        fail("digests", error);
      }
    }
    if (nextHousekeepingAt !== null && now >= nextHousekeepingAt) {
      nextHousekeepingAt = now + timing.housekeepingEveryMs;
      try {
        jobs.housekeeping(now);
      } catch (error) {
        fail("housekeeping", error);
      }
    }
  }

  function logSummary(now: number, gate: ModelGate | null): void {
    if (nextSummaryAt === null || now < nextSummaryAt) return;
    nextSummaryAt = now + timing.summaryEveryMs;
    const c = counters;
    counters = emptyCounters();
    log(
      `[worker] last minute: ${c.checks} checks, ${c.judged} judged, ${c.failed} failed, ` +
        `${c.analyses} analyses, ${c.rejudgeSteps} re-judge steps; ` +
        `in flight: ${sourcesInFlight.size} checks, ${itemsInFlight.size} judge calls; model: ${gateWords(gate)}`,
    );
  }

  function beat(now: number): boolean {
    try {
      return options.heartbeat(now);
    } catch (error) {
      // A failed write is not a lost lease: the next tick tries again.
      fail("heartbeat", error);
      return true;
    }
  }

  function tick(): TickResult {
    const idle: TickResult = { didWork: false, nextDelayMs: timing.idleTickMs };
    if (stopping || leaseLost) return idle;
    const now = options.now();
    if (nextDigestAt === null) {
      nextDigestAt = now;
      nextHousekeepingAt = now + timing.housekeepingFirstMs;
      nextSummaryAt = now + timing.summaryEveryMs;
    }

    if (!beat(now)) {
      leaseLost = true;
      options.onLeaseLost?.();
      return idle;
    }

    let didWork = workSinceLastTick;
    workSinceLastTick = false;
    if (startChecks(now) > 0) didWork = true;
    const gate = readGate(now);
    if (startModelWork(now, gate) > 0) didWork = true;
    runTimedStages(now);
    logSummary(now, gate);
    return { didWork, nextDelayMs: didWork ? timing.busyTickMs : timing.idleTickMs };
  }

  function loop(): void {
    timer = null;
    if (stopping || leaseLost) return;
    const { nextDelayMs } = tick();
    if (!stopping && !leaseLost) timer = timers.setTimeout(loop, nextDelayMs);
  }

  async function settle(): Promise<void> {
    while (running.size > 0) await Promise.allSettled([...running]);
  }

  async function stop(timeoutMs: number = STOP_TIMEOUT_MS): Promise<{ finished: boolean; unfinished: number }> {
    stopping = true;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    let waitTimer: unknown = null;
    const timeout = new Promise<false>((resolve) => {
      waitTimer = timers.setTimeout(() => resolve(false), timeoutMs);
    });
    const finished = await Promise.race([settle().then(() => true as const), timeout]);
    timers.clearTimeout(waitTimer);
    return { finished, unfinished: running.size };
  }

  return {
    start() {
      if (started || stopping) return;
      started = true;
      loop();
    },
    stop,
    tick,
    inFlight: () => ({
      sourceIds: [...sourcesInFlight],
      itemIds: [...itemsInFlight],
      analysis: analysisInFlight,
      rejudge: rejudgeInFlight,
    }),
    settle,
  };
}
