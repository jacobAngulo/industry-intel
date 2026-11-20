import { describe, expect, it, vi } from "vitest";

import type { ModelGate, PipelineDeps } from "@/lib/pipeline";

import {
  STOP_TIMEOUT_MS,
  WORKER_TIMING,
  createWorker,
  describeError,
  type CheckResult,
  type JudgeOutcome,
  type WorkerJobs,
  type WorkerOptions,
} from "./loop";

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const DEPS = { marker: "deps" } as unknown as PipelineDeps;
const OPEN: ModelGate = { open: true };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CHECK_OK: CheckResult = { ran: true, ok: true, itemsFound: 3, itemsNew: 2 };

function fakeJobs(overrides: Partial<WorkerJobs> = {}): WorkerJobs {
  return {
    dueSourceIds: vi.fn(() => [] as number[]),
    checkSource: vi.fn(async () => CHECK_OK),
    modelGate: vi.fn(() => OPEN),
    claimItemsToJudge: vi.fn(() => [] as number[]),
    judgeItem: vi.fn(async () => ({ outcome: "judged" as JudgeOutcome })),
    runNextAnalysis: vi.fn(async () => false),
    runRejudgeStep: vi.fn(async () => false),
    createDueDigests: vi.fn(() => 0),
    housekeeping: vi.fn(() => undefined),
    ...overrides,
  };
}

function setup(jobOverrides: Partial<WorkerJobs> = {}, options: Partial<WorkerOptions> = {}) {
  const clock = { now: T0 };
  const jobs = fakeJobs(jobOverrides);
  const lines: string[] = [];
  const errors: Array<{ message: string; data: Record<string, unknown> }> = [];
  const heartbeat = vi.fn((now: number) => {
    void now;
    return true;
  });
  const worker = createWorker({
    jobs,
    deps: DEPS,
    now: () => clock.now,
    heartbeat,
    log: (line) => lines.push(line),
    reportError: (message, data) => errors.push({ message, data }),
    ...options,
  });
  return {
    worker,
    jobs,
    lines,
    errors,
    heartbeat,
    clock,
    advance(ms: number) {
      clock.now += ms;
    },
  };
}

/** Ids of the form [1, 2, ...] for `limit` slots, from a counter (each id once). */
function idSource(start = 1) {
  let next = start;
  return vi.fn((limit: number) => Array.from({ length: limit }, () => next++));
}

describe("timing constants", () => {
  it("match §7.1 and the task", () => {
    expect(WORKER_TIMING).toMatchObject({
      idleTickMs: 5000,
      busyTickMs: 1000,
      digestEveryMs: 60_000,
      housekeepingEveryMs: 3_600_000,
      housekeepingFirstMs: 60_000,
      maxChecks: 4,
      maxJudges: 3,
      maxAnalyses: 1,
      maxRejudges: 1,
    });
    expect(STOP_TIMEOUT_MS).toBe(5000);
  });
});

describe("order of the stages", () => {
  it("runs heartbeat, checks, gate, judge, analysis, re-judge, digests in this order", () => {
    const order: string[] = [];
    const s = setup({
      dueSourceIds: () => (order.push("due"), [1]),
      checkSource: async () => (order.push("check"), CHECK_OK),
      modelGate: () => (order.push("gate"), OPEN),
      claimItemsToJudge: () => (order.push("claim"), []),
      runNextAnalysis: async () => (order.push("analysis"), false),
      runRejudgeStep: async () => (order.push("rejudge"), false),
      createDueDigests: () => (order.push("digests"), 0),
      housekeeping: () => void order.push("housekeeping"),
    }, {
      heartbeat: (now) => (order.push(`beat@${now - T0}`), true),
    });
    s.worker.tick();
    expect(order).toEqual(["beat@0", "due", "check", "gate", "claim", "analysis", "rejudge", "digests"]);
  });

  it("passes the clock time and the deps to the jobs", async () => {
    const s = setup({ dueSourceIds: vi.fn(() => [7]), claimItemsToJudge: vi.fn(() => [9]) });
    s.worker.tick();
    await s.worker.settle();
    expect(s.jobs.dueSourceIds).toHaveBeenCalledWith(4, T0);
    expect(s.jobs.checkSource).toHaveBeenCalledWith(7, DEPS);
    expect(s.jobs.modelGate).toHaveBeenCalledWith(T0);
    expect(s.jobs.claimItemsToJudge).toHaveBeenCalledWith(3, [], T0);
    expect(s.jobs.judgeItem).toHaveBeenCalledWith(9, DEPS);
    expect(s.jobs.runNextAnalysis).toHaveBeenCalledWith(DEPS);
    expect(s.jobs.createDueDigests).toHaveBeenCalledWith(T0);
  });
});

describe("stage 2: source checks", () => {
  it("keeps at most 4 checks in flight and asks only for the free slots", () => {
    const pending: Array<Deferred<CheckResult>> = [];
    const due = idSource();
    const s = setup({
      dueSourceIds: due,
      checkSource: vi.fn(() => {
        const d = deferred<CheckResult>();
        pending.push(d);
        return d.promise;
      }),
    });
    s.worker.tick();
    expect(due).toHaveBeenLastCalledWith(4, T0);
    expect(s.jobs.checkSource).toHaveBeenCalledTimes(4);
    expect(s.worker.inFlight().sourceIds).toEqual([1, 2, 3, 4]);

    s.advance(1000);
    s.worker.tick();
    expect(due).toHaveBeenCalledTimes(1); // no free slot: no query
    expect(s.jobs.checkSource).toHaveBeenCalledTimes(4);
  });

  it("asks for the free slots after some checks finish", async () => {
    const pending: Array<Deferred<CheckResult>> = [];
    const due = idSource();
    const s = setup({
      dueSourceIds: due,
      checkSource: vi.fn(() => {
        const d = deferred<CheckResult>();
        pending.push(d);
        return d.promise;
      }),
    });
    s.worker.tick();
    pending[0]!.resolve(CHECK_OK);
    pending[1]!.resolve(CHECK_OK);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    s.worker.tick();
    expect(due).toHaveBeenLastCalledWith(2, T0);
    expect(s.worker.inFlight().sourceIds).toEqual([3, 4, 5, 6]);
  });

  it("never starts a second check for a source that is in flight", () => {
    const d = deferred<CheckResult>();
    const s = setup({
      dueSourceIds: vi.fn(() => [5]),
      checkSource: vi.fn(() => d.promise),
    });
    s.worker.tick();
    s.worker.tick();
    expect(s.jobs.checkSource).toHaveBeenCalledTimes(1);
  });

  it("runs the checks also when the model gate is closed", () => {
    const s = setup({ dueSourceIds: vi.fn(() => [1]), modelGate: vi.fn(() => ({ open: false, reason: "no_key" as const })) });
    s.worker.tick();
    expect(s.jobs.checkSource).toHaveBeenCalledTimes(1);
  });

  it("logs one line for each finished check", async () => {
    let n = 0;
    const results: CheckResult[] = [
      { ran: true, ok: true, itemsFound: 30, itemsNew: 5 },
      { ran: true, ok: false, itemsFound: 0, itemsNew: 0, error: "The feed address returned 404" },
      { ran: false, ok: false, itemsFound: 0, itemsNew: 0, error: "Needs an X API token" },
    ];
    const s = setup({
      dueSourceIds: vi.fn(() => [11, 12, 13]),
      checkSource: vi.fn(async () => results[n++]!),
    });
    s.worker.tick();
    await s.worker.settle();
    expect(s.lines).toEqual([
      "[worker] source 11 checked: 30 found, 5 new",
      "[worker] source 12 check failed: The feed address returned 404",
      "[worker] source 13 not checked: Needs an X API token",
    ]);
  });
});

describe("stage 3: judge", () => {
  it("keeps at most 3 judge calls in flight and passes the ids in flight to the claim", async () => {
    const pending = new Map<number, Deferred<{ outcome: JudgeOutcome }>>();
    const claim = idSource(100);
    const s = setup({
      claimItemsToJudge: claim,
      judgeItem: vi.fn((id: number) => {
        const d = deferred<{ outcome: JudgeOutcome }>();
        pending.set(id, d);
        return d.promise;
      }),
    });
    s.worker.tick();
    expect(claim).toHaveBeenLastCalledWith(3, [], T0);
    expect(s.worker.inFlight().itemIds).toEqual([100, 101, 102]);

    s.worker.tick();
    expect(claim).toHaveBeenCalledTimes(1); // no free slot

    pending.get(101)!.resolve({ outcome: "judged" });
    await new Promise((resolve) => setImmediate(resolve));
    s.worker.tick();
    expect(claim).toHaveBeenLastCalledWith(1, [100, 102], T0);
    expect(s.jobs.judgeItem).toHaveBeenCalledTimes(4);
  });

  it("ignores a claimed id that is in flight already", () => {
    const d = deferred<{ outcome: JudgeOutcome }>();
    const s = setup({
      claimItemsToJudge: vi.fn(() => [8]),
      judgeItem: vi.fn(() => d.promise),
    });
    s.worker.tick();
    s.worker.tick();
    expect(s.jobs.judgeItem).toHaveBeenCalledTimes(1);
  });

  it.each(["no_key", "paused", "budget"] as const)("skips stages 3 to 5 when the gate is closed (%s)", (reason) => {
    const s = setup({
      modelGate: vi.fn(() => ({ open: false, reason })),
      claimItemsToJudge: vi.fn(() => [1]),
    });
    s.worker.tick();
    expect(s.jobs.claimItemsToJudge).not.toHaveBeenCalled();
    expect(s.jobs.runNextAnalysis).not.toHaveBeenCalled();
    expect(s.jobs.runRejudgeStep).not.toHaveBeenCalled();
  });

  it("starts the model work again when the gate opens", () => {
    let gate: ModelGate = { open: false, reason: "paused", until: T0 + 60_000 };
    const s = setup({ modelGate: vi.fn(() => gate) });
    s.worker.tick();
    expect(s.jobs.claimItemsToJudge).not.toHaveBeenCalled();
    gate = OPEN;
    s.advance(5000);
    s.worker.tick();
    expect(s.jobs.claimItemsToJudge).toHaveBeenCalledTimes(1);
  });

  it("logs one line for each judged item outcome", async () => {
    const outcomes: JudgeOutcome[] = ["judged", "joined", "failed"];
    let n = 0;
    const s = setup({
      claimItemsToJudge: vi.fn(() => [1, 2, 3]),
      judgeItem: vi.fn(async () => ({ outcome: outcomes[n++]! })),
    });
    s.worker.tick();
    await s.worker.settle();
    expect(s.lines).toEqual(["[worker] item 1: judged", "[worker] item 2: joined a story", "[worker] item 3: failed"]);
  });
});

describe("stage 4: analyses", () => {
  it("runs one analysis at a time", async () => {
    const d = deferred<boolean>();
    const s = setup({ runNextAnalysis: vi.fn(() => d.promise) });
    s.worker.tick();
    s.worker.tick();
    expect(s.jobs.runNextAnalysis).toHaveBeenCalledTimes(1);
    expect(s.worker.inFlight().analysis).toBe(true);
    d.resolve(true);
    await s.worker.settle();
    expect(s.worker.inFlight().analysis).toBe(false);
    s.worker.tick();
    expect(s.jobs.runNextAnalysis).toHaveBeenCalledTimes(2);
  });

  it("does not wait for the judge stage", () => {
    const s = setup({ claimItemsToJudge: vi.fn(() => [1, 2, 3]), judgeItem: vi.fn(() => new Promise<never>(() => {})) });
    s.worker.tick();
    expect(s.jobs.runNextAnalysis).toHaveBeenCalledTimes(1);
  });
});

describe("stage 5: re-judge", () => {
  it("runs when the claim returned nothing and no judge call is in flight", () => {
    const s = setup();
    s.worker.tick();
    expect(s.jobs.runRejudgeStep).toHaveBeenCalledWith(DEPS);
  });

  it("waits while the claim returns items", () => {
    const s = setup({ claimItemsToJudge: vi.fn(() => [1]) });
    s.worker.tick();
    expect(s.jobs.runRejudgeStep).not.toHaveBeenCalled();
  });

  it("waits while a judge call of an earlier tick is in flight", () => {
    let claimed = false;
    const s = setup({
      claimItemsToJudge: vi.fn(() => {
        if (claimed) return [];
        claimed = true;
        return [1];
      }),
      judgeItem: vi.fn(() => new Promise<never>(() => {})),
    });
    s.worker.tick();
    s.worker.tick();
    expect(s.jobs.claimItemsToJudge).toHaveBeenCalledTimes(2);
    expect(s.jobs.runRejudgeStep).not.toHaveBeenCalled();
  });

  it("runs one step at a time", async () => {
    const d = deferred<boolean>();
    const s = setup({ runRejudgeStep: vi.fn(() => d.promise) });
    s.worker.tick();
    s.worker.tick();
    expect(s.jobs.runRejudgeStep).toHaveBeenCalledTimes(1);
    d.resolve(false);
    await s.worker.settle();
    s.worker.tick();
    expect(s.jobs.runRejudgeStep).toHaveBeenCalledTimes(2);
  });
});

describe("the rhythm of the ticks", () => {
  it("waits 5 s after a tick with no work", () => {
    const s = setup();
    expect(s.worker.tick()).toEqual({ didWork: false, nextDelayMs: 5000 });
  });

  it("waits 1 s after a tick that started checks", () => {
    const s = setup({ dueSourceIds: vi.fn(() => [1]) });
    expect(s.worker.tick()).toEqual({ didWork: true, nextDelayMs: 1000 });
  });

  it("waits 1 s after a tick that claimed items", () => {
    const s = setup({ claimItemsToJudge: vi.fn(() => [1]) });
    expect(s.worker.tick().nextDelayMs).toBe(1000);
  });

  it("waits 1 s after an analysis or a re-judge step that did work, then 5 s again", async () => {
    let analysisWork = true;
    const s = setup({ runNextAnalysis: vi.fn(async () => analysisWork) });
    s.worker.tick();
    await s.worker.settle();
    analysisWork = false;
    expect(s.worker.tick().nextDelayMs).toBe(1000);
    await s.worker.settle();
    expect(s.worker.tick().nextDelayMs).toBe(5000);

    const r = setup({ runRejudgeStep: vi.fn(async () => true) });
    r.worker.tick();
    await r.worker.settle();
    expect(r.worker.tick().nextDelayMs).toBe(1000);
  });

  it("counts a paused judge outcome and a check that did not run as no work", async () => {
    let first = true;
    const s = setup({
      dueSourceIds: vi.fn(() => (first ? [1] : [])),
      checkSource: vi.fn(async () => ({ ran: false, ok: false, itemsFound: 0, itemsNew: 0 })),
      claimItemsToJudge: vi.fn(() => (first ? [2] : [])),
      judgeItem: vi.fn(async () => ({ outcome: "paused" as JudgeOutcome })),
    });
    s.worker.tick();
    first = false;
    await s.worker.settle();
    expect(s.worker.tick().nextDelayMs).toBe(5000);
  });

  it("start() runs a tick at once and schedules the next one by the result", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    let due = [1];
    const s = setup(
      { dueSourceIds: vi.fn(() => due), checkSource: vi.fn(() => new Promise<never>(() => {})) },
      {
        timers: {
          setTimeout: (fn, ms) => scheduled.push({ fn, ms }),
          clearTimeout: () => undefined,
        },
      },
    );
    s.worker.start();
    s.worker.start(); // a second call does nothing
    expect(s.heartbeat).toHaveBeenCalledTimes(1);
    expect(scheduled.map((x) => x.ms)).toEqual([1000]);
    due = [];
    scheduled[0]!.fn();
    expect(s.heartbeat).toHaveBeenCalledTimes(2);
    expect(scheduled.map((x) => x.ms)).toEqual([1000, 5000]);
  });
});

describe("digests and housekeeping", () => {
  it("creates the due digests at the first tick and then once each minute", () => {
    const s = setup();
    s.worker.tick();
    expect(s.jobs.createDueDigests).toHaveBeenCalledTimes(1);
    s.advance(30_000);
    s.worker.tick();
    expect(s.jobs.createDueDigests).toHaveBeenCalledTimes(1);
    s.advance(30_000);
    s.worker.tick();
    expect(s.jobs.createDueDigests).toHaveBeenCalledTimes(2);
    expect(s.jobs.createDueDigests).toHaveBeenLastCalledWith(T0 + 60_000);
  });

  it("runs housekeeping one time 1 minute after the start, then each hour", () => {
    const s = setup();
    s.worker.tick();
    s.advance(59_000);
    s.worker.tick();
    expect(s.jobs.housekeeping).not.toHaveBeenCalled();
    s.advance(1000);
    s.worker.tick();
    expect(s.jobs.housekeeping).toHaveBeenCalledWith(T0 + 60_000);
    s.advance(30 * 60_000);
    s.worker.tick();
    expect(s.jobs.housekeeping).toHaveBeenCalledTimes(1);
    s.advance(30 * 60_000);
    s.worker.tick();
    expect(s.jobs.housekeeping).toHaveBeenCalledTimes(2);
    expect(s.jobs.housekeeping).toHaveBeenLastCalledWith(T0 + 60_000 + 3_600_000);
  });

  it("runs digests and housekeeping also when the model gate is closed", () => {
    const s = setup({ modelGate: vi.fn(() => ({ open: false, reason: "no_key" as const })) });
    s.worker.tick();
    s.advance(60_000);
    s.worker.tick();
    expect(s.jobs.createDueDigests).toHaveBeenCalledTimes(2);
    expect(s.jobs.housekeeping).toHaveBeenCalledTimes(1);
  });
});

describe("error isolation", () => {
  it("an exception in one stage does not stop the other stages or the loop", async () => {
    const s = setup({
      dueSourceIds: vi.fn(() => [1]),
      checkSource: vi.fn(async () => {
        throw new Error("check broke");
      }),
      claimItemsToJudge: vi.fn(() => [2]),
      judgeItem: vi.fn(async () => {
        throw new Error("judge broke");
      }),
      runNextAnalysis: vi.fn(() => {
        throw new Error("analysis broke");
      }),
      createDueDigests: vi.fn(() => {
        throw new Error("digests broke");
      }),
      housekeeping: vi.fn(() => {
        throw new Error("housekeeping broke");
      }),
    });
    s.worker.tick();
    await s.worker.settle();
    s.advance(60_000);
    s.worker.tick();
    await s.worker.settle();

    expect(s.jobs.checkSource).toHaveBeenCalledTimes(2);
    expect(s.jobs.judgeItem).toHaveBeenCalledTimes(2);
    expect(s.jobs.runNextAnalysis).toHaveBeenCalledTimes(2);
    expect(s.jobs.createDueDigests).toHaveBeenCalledTimes(2);
    expect(s.jobs.housekeeping).toHaveBeenCalledTimes(1);
    const stages = new Set(s.errors.map((e) => e.data.stage));
    expect(stages).toEqual(new Set(["checks", "judge", "analysis", "digests", "housekeeping"]));
    expect(s.errors.find((e) => e.data.stage === "checks")?.data.sourceId).toBe(1);
    expect(s.errors.find((e) => e.data.stage === "judge")?.message).toContain("judge broke");
    // The in-flight marks are gone after the failure.
    expect(s.worker.inFlight()).toEqual({ sourceIds: [], itemIds: [], analysis: false, rejudge: false });
  });

  it("a failing query of due sources does not stop the judge stage", () => {
    const s = setup({
      dueSourceIds: vi.fn(() => {
        throw new Error("database is locked");
      }),
      claimItemsToJudge: vi.fn(() => [1]),
    });
    expect(s.worker.tick().didWork).toBe(true);
    expect(s.jobs.judgeItem).toHaveBeenCalledTimes(1);
    expect(s.errors[0]!.message).toBe("The checks stage failed: database is locked");
  });

  it("a failing model gate counts as closed", () => {
    const s = setup({
      dueSourceIds: vi.fn(() => [1]),
      modelGate: vi.fn(() => {
        throw new Error("gate broke");
      }),
    });
    s.worker.tick();
    expect(s.jobs.checkSource).toHaveBeenCalledTimes(1);
    expect(s.jobs.claimItemsToJudge).not.toHaveBeenCalled();
    expect(s.errors[0]!.data.stage).toBe("model gate");
  });

  it("a failing heartbeat is logged and the stages still run", () => {
    const s = setup(
      { dueSourceIds: vi.fn(() => [1]) },
      {
        heartbeat: () => {
          throw new Error("disk full");
        },
      },
    );
    s.worker.tick();
    expect(s.jobs.checkSource).toHaveBeenCalledTimes(1);
    expect(s.errors[0]!.data.stage).toBe("heartbeat");
  });

  it("a throwing error reporter does not break the loop", () => {
    const s = setup(
      {
        createDueDigests: vi.fn(() => {
          throw new Error("x");
        }),
      },
      {
        reportError: () => {
          throw new Error("the log is broken too");
        },
      },
    );
    expect(() => s.worker.tick()).not.toThrow();
  });

  it("logs the same error of a stage at most one time each minute", () => {
    const s = setup({
      dueSourceIds: vi.fn(() => {
        throw new Error("same");
      }),
    });
    s.worker.tick();
    s.advance(5000);
    s.worker.tick();
    expect(s.errors).toHaveLength(1);
    s.advance(60_000);
    s.worker.tick();
    expect(s.errors).toHaveLength(2);
  });

  it("never puts a secret value into an error or a log line", async () => {
    const secret = "sk-very-secret-value-123";
    const s = setup(
      {
        dueSourceIds: vi.fn(() => [1]),
        checkSource: vi.fn(async () => ({ ran: true, ok: false, itemsFound: 0, itemsNew: 0, error: `bad token ${secret}` })),
        createDueDigests: vi.fn(() => {
          throw new Error(`Authorization: Bearer ${secret}`);
        }),
      },
      { secrets: () => [secret, undefined] },
    );
    s.worker.tick();
    await s.worker.settle();
    const all = JSON.stringify([s.lines, s.errors]);
    expect(all).not.toContain(secret);
    expect(all).toContain("[hidden]");
  });

  it("the default error reporter writes an error event of scope worker", async () => {
    const log = await import("@/lib/log");
    const spy = vi.spyOn(log, "logEvent").mockImplementation(() => undefined);
    try {
      const worker = createWorker({
        jobs: fakeJobs({
          createDueDigests: vi.fn(() => {
            throw new Error("boom");
          }),
        }),
        deps: DEPS,
        now: () => T0,
        heartbeat: () => true,
        log: () => undefined,
      });
      worker.tick();
      expect(spy).toHaveBeenCalledWith("error", "worker", "The digests stage failed: boom", { stage: "digests" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("describeError", () => {
  it("gives one short line", () => {
    expect(describeError(new Error("a\n  b"))).toBe("a b");
    expect(describeError("text")).toBe("text");
    expect(describeError(42)).toBe("unknown error");
    expect(describeError(new Error("x".repeat(500)))).toHaveLength(300);
  });

  it("hides each secret value but not very short values", () => {
    expect(describeError(new Error("key abcdef123 in abcdef123"), ["abcdef123"])).toBe("key [hidden] in [hidden]");
    expect(describeError(new Error("a b c"), ["a", undefined])).toBe("a b c");
  });
});

describe("summary line", () => {
  it("logs the counters of the last minute each minute", async () => {
    const outcomes: JudgeOutcome[] = ["judged", "failed"];
    let n = 0;
    let first = true;
    const s = setup({
      dueSourceIds: vi.fn(() => (first ? [1, 2] : [])),
      claimItemsToJudge: vi.fn(() => (first ? [5, 6] : [])),
      judgeItem: vi.fn(async () => ({ outcome: outcomes[n++]! })),
      runNextAnalysis: vi.fn(async () => first),
      runRejudgeStep: vi.fn(async () => true),
    });
    s.worker.tick();
    first = false;
    await s.worker.settle();
    s.advance(30_000);
    s.worker.tick(); // re-judge runs here (claim is empty now)
    await s.worker.settle();
    expect(s.lines.some((l) => l.includes("last minute"))).toBe(false);
    s.advance(30_000);
    s.worker.tick();
    const summary = s.lines.find((l) => l.includes("last minute"));
    expect(summary).toBe(
      "[worker] last minute: 2 checks, 1 judged, 1 failed, 1 analyses, 1 re-judge steps; in flight: 0 checks, 0 judge calls; model: open",
    );
    await s.worker.settle();
    s.advance(60_000);
    s.worker.tick();
    expect(s.lines.filter((l) => l.includes("last minute")).at(-1)).toContain("0 checks, 0 judged, 0 failed");
  });

  it("says why the model gate is closed", () => {
    const s = setup({ modelGate: vi.fn(() => ({ open: false, reason: "budget" as const })) });
    s.worker.tick();
    s.advance(60_000);
    s.worker.tick();
    expect(s.lines.at(-1)).toContain("model: daily limit used");
  });
});

describe("lease lost", () => {
  it("calls onLeaseLost one time and starts no work after that", () => {
    const onLeaseLost = vi.fn();
    const s = setup({ dueSourceIds: vi.fn(() => [1]) }, { heartbeat: () => false, onLeaseLost });
    expect(s.worker.tick().didWork).toBe(false);
    s.worker.tick();
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(s.jobs.dueSourceIds).not.toHaveBeenCalled();
    expect(s.jobs.createDueDigests).not.toHaveBeenCalled();
  });

  it("does not schedule more ticks", () => {
    const scheduled: number[] = [];
    const s = setup(
      {},
      {
        heartbeat: () => false,
        timers: { setTimeout: (_fn, ms) => scheduled.push(ms), clearTimeout: () => undefined },
      },
    );
    s.worker.start();
    expect(scheduled).toEqual([]);
  });
});

describe("stop", () => {
  it("waits for the work in flight and starts no new work", async () => {
    const d = deferred<CheckResult>();
    const s = setup({ dueSourceIds: vi.fn(() => [1, 2]), checkSource: vi.fn(() => d.promise) });
    s.worker.tick();
    let stopped = false;
    const stopping = s.worker.stop(5000).then((result) => {
      stopped = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(s.worker.tick()).toEqual({ didWork: false, nextDelayMs: 5000 });
    expect(s.jobs.dueSourceIds).toHaveBeenCalledTimes(1);
    d.resolve(CHECK_OK);
    expect(await stopping).toEqual({ finished: true, unfinished: 0 });
  });

  it("gives up after the timeout and reports the unfinished jobs", async () => {
    const s = setup({
      dueSourceIds: vi.fn(() => [1]),
      checkSource: vi.fn(() => new Promise<never>(() => {})),
      claimItemsToJudge: vi.fn(() => [2]),
      judgeItem: vi.fn(() => new Promise<never>(() => {})),
    });
    s.worker.tick();
    const started = Date.now();
    expect(await s.worker.stop(30)).toEqual({ finished: false, unfinished: 2 }); // the check and the judge call
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns at once when nothing is in flight", async () => {
    const s = setup();
    expect(await s.worker.stop()).toEqual({ finished: true, unfinished: 0 });
  });

  it("clears the scheduled tick", async () => {
    const cleared: unknown[] = [];
    const s = setup(
      {},
      {
        timers: {
          setTimeout: (fn, ms) => (ms === 5000 && cleared.length === 0 ? "tick-timer" : setTimeout(fn, ms)),
          clearTimeout: (handle) => {
            cleared.push(handle);
            if (handle !== "tick-timer") clearTimeout(handle as ReturnType<typeof setTimeout>);
          },
        },
      },
    );
    s.worker.start();
    await s.worker.stop(50);
    expect(cleared[0]).toBe("tick-timer");
    s.worker.start(); // no restart after stop
    expect(s.heartbeat).toHaveBeenCalledTimes(1);
  });
});
