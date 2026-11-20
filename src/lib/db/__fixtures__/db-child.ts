// Child process for client.test.ts. The test starts it with
// `node --import tsx`, so it also proves that the `@/` alias works in tsx.
//
// Protocol:
//   1. argv[2] is the mode: "migrate", "write", or "transact".
//      For "transact", argv[3] is the transaction behavior (default "immediate").
//   2. The child prints "ready".
//   3. The parent sends "go <unix time in ms>" on stdin.
//   4. The child waits for that time, does the work, and prints one JSON line.
import { count } from "drizzle-orm";

import { closeDb, getDb } from "@/lib/db/client";
import { events } from "@/lib/db/schema";

const WRITES = 200;
const mode = process.argv[2];

function waitUntil(time: number): void {
  // A busy wait gives all children the same start time (in 1 ms).
  while (Date.now() < time) {
    /* wait */
  }
}

function work(startAt: number): Record<string, unknown> {
  if (mode === "migrate") {
    waitUntil(startAt);
    getDb();
    return { mode };
  }
  if (mode === "write") {
    const db = getDb();
    waitUntil(startAt);
    const first = Date.now();
    for (let i = 0; i < WRITES; i += 1) {
      // Each insert is its own transaction, so the two processes alternate.
      db.insert(events).values({ at: Date.now(), level: "info", scope: "child", message: "write" }).run();
    }
    return { mode, written: WRITES, first, last: Date.now() };
  }
  if (mode === "transact") {
    const behavior = process.argv[3] === "deferred" ? "deferred" : "immediate";
    const db = getDb();
    waitUntil(startAt);
    const first = Date.now();
    for (let i = 0; i < WRITES; i += 1) {
      // A transaction that reads, then writes.
      db.transaction(
        (tx) => {
          const row = tx.select({ n: count() }).from(events).get();
          tx.insert(events)
            .values({ at: Date.now(), level: "info", scope: "child", message: (row?.n ?? 0) % 2 ? "odd" : "even" })
            .run();
        },
        { behavior },
      );
    }
    return { mode, written: WRITES, first, last: Date.now() };
  }
  throw new Error(`unknown mode: ${mode}`);
}

process.stdin.setEncoding("utf8");
process.stdin.once("data", (line: string) => {
  const startAt = Number(line.trim().split(" ")[1]);
  try {
    const result = work(startAt);
    closeDb();
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});

if (mode !== "migrate") getDb();
console.log("ready");
