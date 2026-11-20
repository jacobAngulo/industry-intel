// The worker process (specification §7.1). Start it with `npm run dev:worker`
// or `npm run start:worker`. The first import loads `.env`. Keep it first.
//
// This file only wires the real functions into the loop (loop.ts) and
// handles the lease (lease.ts) and the signals. The logic and its tests are
// in loop.ts and lease.ts.
import "@/lib/load-env";

import { randomUUID } from "node:crypto";

import { closeDb, ensureDatabase, resolveDatabasePath } from "@/lib/db/client";
import { getDeps } from "@/lib/deps";
import { createDueDigests } from "@/lib/digests";
import { hasMailbox, hasModelKey, hasXToken } from "@/lib/env";
import {
  checkSource,
  claimItemsToJudge,
  dueSourceIds,
  housekeeping,
  judgeItem,
  modelGate,
  runNextAnalysis,
  runRejudgeStep,
} from "@/lib/pipeline";
import { nowMs } from "@/lib/time";

import { releaseLease, renewLease, takeLease } from "./lease";
import { STOP_TIMEOUT_MS, createWorker, describeError } from "./loop";

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function main(): void {
  try {
    ensureDatabase();
  } catch (error) {
    console.error(`[worker] The database did not open: ${describeError(error)}`);
    process.exit(1);
  }

  const leaseId = randomUUID();
  const lease = takeLease(leaseId, nowMs());
  if (!lease.taken) {
    console.log(`[worker] A worker runs already (lease expires at ${new Date(lease.holder.expiresAt).toISOString()}).`);
    closeDb();
    process.exit(0);
  }

  const deps = getDeps();
  const env = deps.env;
  // Read at each heartbeat: a key saved on the settings page applies with no restart.
  const envFlags = () => ({ hasModelKey: hasModelKey(env), hasXToken: hasXToken(env), hasMailbox: hasMailbox(env) });
  const flags = envFlags();
  console.log(
    `[worker] started: pid ${process.pid}, node ${process.version}, database ${resolveDatabasePath()}, ` +
      `model key: ${yesNo(flags.hasModelKey)}, X token: ${yesNo(flags.hasXToken)}, mailbox: ${yesNo(flags.hasMailbox)}`,
  );

  let stopping = false;

  const worker = createWorker({
    jobs: {
      dueSourceIds,
      checkSource,
      modelGate: (now) => modelGate(now, env),
      claimItemsToJudge,
      judgeItem,
      runNextAnalysis,
      runRejudgeStep,
      createDueDigests,
      housekeeping,
    },
    deps,
    now: nowMs,
    heartbeat: (now) => renewLease(leaseId, { at: now, ...envFlags() }),
    onLeaseLost: () => {
      console.error("[worker] Another worker took the lease. This worker stops.");
      void shutdown("lease lost", 1);
    },
    secrets: () => [env.ollamaApiKey, env.xBearerToken, env.githubToken, env.redditClientSecret, env.imapPassword],
  });

  function releaseQuietly(): void {
    try {
      releaseLease(leaseId);
    } catch {
      // The lease expires by time (30 s).
    }
  }

  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    const result = await worker.stop(STOP_TIMEOUT_MS);
    releaseQuietly();
    closeDb();
    const work = result.finished ? "all work finished" : `${result.unfinished} jobs did not finish in time`;
    console.log(`[worker] stopped (${reason}; ${work}).`);
    process.exit(exitCode);
  }

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      // A second signal: no more waiting. The locks of the jobs expire by time.
      console.log(`[worker] ${signal} again: stop now.`);
      releaseQuietly();
      process.exit(1);
    }
    void shutdown(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  worker.start();
}

main();
