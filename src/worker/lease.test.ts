import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKER_STATE_KEYS, readHeartbeat, readWorkerState, writeWorkerState } from "@/lib/pipeline/jobs";
import type { PipelineDeps } from "@/lib/pipeline";
import type { WorkerLease } from "@/lib/types";
import { installTestDb, type InstalledTestDb } from "@/test/helpers";

import { LEASE_TTL_MS, releaseLease, renewLease, takeLease } from "./lease";
import { createWorker, type WorkerJobs } from "./loop";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const BEAT = { hasModelKey: false, hasXToken: true, hasMailbox: false };

let t: InstalledTestDb;

beforeEach(() => {
  t = installTestDb();
});

afterEach(() => {
  t.cleanup();
});

function lease(): WorkerLease | null {
  return readWorkerState<WorkerLease>(WORKER_STATE_KEYS.lease);
}

describe("takeLease", () => {
  it("takes a free lease for 30 s", () => {
    expect(takeLease("a", NOW)).toEqual({ taken: true });
    expect(lease()).toEqual({ id: "a", expiresAt: NOW + LEASE_TTL_MS });
    expect(LEASE_TTL_MS).toBe(30_000);
  });

  it("refuses when another worker holds a live lease, and changes nothing", () => {
    takeLease("a", NOW);
    const result = takeLease("b", NOW + 10_000);
    expect(result).toEqual({ taken: false, holder: { id: "a", expiresAt: NOW + LEASE_TTL_MS } });
    expect(lease()?.id).toBe("a");
  });

  it("refuses up to the last millisecond of the lease", () => {
    takeLease("a", NOW);
    expect(takeLease("b", NOW + LEASE_TTL_MS - 1).taken).toBe(false);
  });

  it("takes over an expired lease", () => {
    takeLease("a", NOW);
    expect(takeLease("b", NOW + LEASE_TTL_MS)).toEqual({ taken: true });
    expect(lease()).toEqual({ id: "b", expiresAt: NOW + 2 * LEASE_TTL_MS });
  });

  it("takes the lease when the stored value is not a lease", () => {
    writeWorkerState(WORKER_STATE_KEYS.lease, "garbage", NOW);
    expect(takeLease("a", NOW).taken).toBe(true);
  });
});

describe("renewLease", () => {
  it("moves the expiry and writes the heartbeat", () => {
    takeLease("a", NOW);
    expect(renewLease("a", { at: NOW + 5000, ...BEAT })).toBe(true);
    expect(lease()).toEqual({ id: "a", expiresAt: NOW + 5000 + LEASE_TTL_MS });
    expect(readHeartbeat()).toEqual({ at: NOW + 5000, ...BEAT });
  });

  it("takes the lease again when its own lease expired and nobody took it", () => {
    takeLease("a", NOW);
    expect(renewLease("a", { at: NOW + 60_000, ...BEAT })).toBe(true);
    expect(lease()?.expiresAt).toBe(NOW + 60_000 + LEASE_TTL_MS);
  });

  it("returns false and writes nothing when another worker holds a live lease", () => {
    takeLease("b", NOW);
    expect(renewLease("a", { at: NOW + 1000, ...BEAT })).toBe(false);
    expect(lease()).toEqual({ id: "b", expiresAt: NOW + LEASE_TTL_MS });
    expect(readHeartbeat()).toBeNull();
  });
});

describe("releaseLease", () => {
  it("deletes its own lease", () => {
    takeLease("a", NOW);
    expect(releaseLease("a")).toBe(true);
    expect(lease()).toBeNull();
  });

  it("never deletes the lease of another worker", () => {
    takeLease("b", NOW);
    expect(releaseLease("a")).toBe(false);
    expect(lease()?.id).toBe("b");
  });

  it("does nothing when there is no lease", () => {
    expect(releaseLease("a")).toBe(false);
  });

  it("lets a second worker start at once after a clean stop", () => {
    takeLease("a", NOW);
    releaseLease("a");
    expect(takeLease("b", NOW + 1).taken).toBe(true);
  });
});

describe("the loop with the real lease", () => {
  function idleJobs(): WorkerJobs {
    return {
      dueSourceIds: () => [],
      checkSource: async () => ({ ran: false, ok: false, itemsFound: 0, itemsNew: 0 }),
      modelGate: () => ({ open: false, reason: "no_key" }),
      claimItemsToJudge: () => [],
      judgeItem: async () => ({ outcome: "judged" }),
      runNextAnalysis: async () => false,
      runRejudgeStep: async () => false,
      createDueDigests: () => 0,
      housekeeping: () => undefined,
    };
  }

  it("renews the lease and writes the heartbeat on each tick", () => {
    let now = NOW;
    takeLease("a", now);
    const worker = createWorker({
      jobs: idleJobs(),
      deps: {} as PipelineDeps,
      now: () => now,
      heartbeat: (at) => renewLease("a", { at, ...BEAT }),
      log: () => undefined,
    });
    worker.tick();
    expect(readHeartbeat()?.at).toBe(NOW);
    now += 5000;
    worker.tick();
    expect(readHeartbeat()?.at).toBe(NOW + 5000);
    expect(lease()?.expiresAt).toBe(NOW + 5000 + LEASE_TTL_MS);
  });

  it("stops work when another worker took the lease", () => {
    const now = NOW;
    takeLease("b", now);
    let lost = 0;
    const jobs = idleJobs();
    let checked = 0;
    jobs.dueSourceIds = () => {
      checked += 1;
      return [];
    };
    const worker = createWorker({
      jobs,
      deps: {} as PipelineDeps,
      now: () => now,
      heartbeat: (at) => renewLease("a", { at, ...BEAT }),
      onLeaseLost: () => (lost += 1),
      log: () => undefined,
    });
    worker.tick();
    worker.tick();
    expect(lost).toBe(1);
    expect(checked).toBe(0);
  });
});
