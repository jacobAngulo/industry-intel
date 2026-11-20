// The worker lease and the heartbeat (specification §7.1).
//
// Only one worker may run against one database file. The worker that holds a
// live lease (worker_state key `worker_lease`) is the worker. Each tick renews
// the lease, so a worker that dies leaves a lease that expires after 30 s.
import { getSqlite } from "@/lib/db/client";
import { WORKER_STATE_KEYS, deleteWorkerState, readWorkerState, writeWorkerState } from "@/lib/pipeline/jobs";
import { SECOND_MS } from "@/lib/time";
import type { WorkerHeartbeat, WorkerLease } from "@/lib/types";

/** A lease lives this long after the last renewal. */
export const LEASE_TTL_MS = 30 * SECOND_MS;

export type TakeLeaseResult = { taken: true } | { taken: false; holder: WorkerLease };

function readLease(): WorkerLease | null {
  const lease = readWorkerState<WorkerLease>(WORKER_STATE_KEYS.lease);
  return lease && typeof lease.id === "string" && typeof lease.expiresAt === "number" ? lease : null;
}

/** The lease of another worker that has not expired, or null. */
function liveLeaseOfOther(id: string, now: number): WorkerLease | null {
  const lease = readLease();
  return lease && lease.id !== id && lease.expiresAt > now ? lease : null;
}

function writeLease(id: string, now: number): void {
  const lease: WorkerLease = { id, expiresAt: now + LEASE_TTL_MS };
  writeWorkerState(WORKER_STATE_KEYS.lease, lease, now);
}

/**
 * Takes the lease when no other worker holds a live one. The read and the
 * write are in one IMMEDIATE transaction, so two workers that start together
 * cannot both take it.
 */
export function takeLease(id: string, now: number): TakeLeaseResult {
  return getSqlite()
    .transaction((): TakeLeaseResult => {
      const holder = liveLeaseOfOther(id, now);
      if (holder) return { taken: false, holder };
      writeLease(id, now);
      return { taken: true };
    })
    .immediate();
}

/**
 * Renews the lease and writes the heartbeat. Returns false, and writes
 * nothing, when another worker holds a live lease now: this worker lost the
 * lease (for example, the process was suspended for more than 30 s) and must
 * stop, so that two workers never run together.
 */
export function renewLease(id: string, heartbeat: WorkerHeartbeat): boolean {
  const now = heartbeat.at;
  return getSqlite()
    .transaction((): boolean => {
      if (liveLeaseOfOther(id, now)) return false;
      writeLease(id, now);
      writeWorkerState(WORKER_STATE_KEYS.heartbeat, heartbeat, now);
      return true;
    })
    .immediate();
}

/** Deletes the lease row only when it is still ours. Returns true when it deleted the row. */
export function releaseLease(id: string): boolean {
  return getSqlite()
    .transaction((): boolean => {
      if (readLease()?.id !== id) return false;
      deleteWorkerState(WORKER_STATE_KEYS.lease);
      return true;
    })
    .immediate();
}
