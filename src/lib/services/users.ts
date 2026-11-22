// People and access (specification §15). Google proves who a person is; an
// approved access request lets that person in. Ops Console shows the pending
// requests and decides them through /api/admin.
import { randomUUID } from "node:crypto";

import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { accessRequests, users } from "@/lib/db/schema";
import { nowMs } from "@/lib/time";

import { notFound, parseOrThrow, ServiceError } from "./_manage-errors";

export type AccessStatus = "none" | "pending" | "approved" | "denied";

/** A signed-in account with its access. Only `access: "approved"` can use the app. */
export interface Account {
  id: string;
  email: string;
  name: string;
  access: AccessStatus;
  isAdmin: boolean;
}

export interface GoogleIdentity {
  /** The Google subject. */
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

/**
 * True for an email in ADMIN_EMAILS (comma-separated). An empty list, or a list
 * with a bad entry, has no administrators: a mistake must not give rights.
 */
export function isAdminEmail(email: string, configured = process.env.ADMIN_EMAILS): boolean {
  const wanted = normalizeEmail(email);
  if (!wanted || !configured?.trim()) return false;
  const emails = configured.split(",").map(normalizeEmail);
  return !emails.includes(null) && emails.includes(wanted);
}

/** Stores the account at each sign-in. It gives no access. */
export function recordSignIn(identity: GoogleIdentity): void {
  const email = normalizeEmail(identity.email);
  if (!identity.id || !email) throw new ServiceError("validation", "The Google account has no usable email address.");
  const name = (identity.name?.replace(/\s+/g, " ").trim() || email.split("@")[0]!).slice(0, MAX_NAME);
  const image = identity.image ?? null;
  const now = nowMs();
  getDb()
    .insert(users)
    .values({ id: identity.id, email, name, image, createdAt: now, lastSignInAt: now })
    .onConflictDoUpdate({ target: users.id, set: { email, name, image, lastSignInAt: now } })
    .run();
}

/** The account with its access now, or null. Read on each request, so a decision applies at once. */
export function getAccount(id: string): Account | null {
  const row = getDb()
    .select({ id: users.id, email: users.email, name: users.name, status: accessRequests.status })
    .from(users)
    .leftJoin(accessRequests, eq(accessRequests.userId, users.id))
    .where(eq(users.id, id))
    .get();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, access: row.status ?? "none", isAdmin: isAdminEmail(row.email) };
}

export const ACCESS_NOTE_MAX = 500;
const noteSchema = z
  .string()
  .trim()
  .max(ACCESS_NOTE_MAX, { error: `Use at most ${ACCESS_NOTE_MAX} characters.` });

/** Asks for access. A pending or approved request stays as it is; a denied one becomes pending again. */
export function submitAccessRequest(userId: string, note: string): AccessStatus {
  const cleaned = parseOrThrow(noteSchema, note, "note") || null;
  return getDb().transaction(
    (tx) => {
      const user = tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
      if (!user) throw notFound("The account");
      const existing = tx.select().from(accessRequests).where(eq(accessRequests.userId, userId)).get();
      if (existing && existing.status !== "denied") return existing.status;
      if (existing) {
        tx.update(accessRequests)
          .set({ email: user.email, note: cleaned, status: "pending", decidedAt: null, decidedBy: null, createdAt: nowMs() })
          .where(eq(accessRequests.id, existing.id))
          .run();
      } else {
        tx.insert(accessRequests)
          .values({ id: randomUUID(), userId, email: user.email, note: cleaned, createdAt: nowMs() })
          .run();
      }
      return "pending";
    },
    { behavior: "immediate" },
  );
}

/** The decision of the operator. A later "deny" of an approved request removes the access. */
export function decideAccessRequest(
  id: string,
  decision: "approve" | "deny",
  operator: string | null,
): { id: string; status: "approved" | "denied" } {
  const status = decision === "approve" ? "approved" : "denied";
  const result = getDb()
    .update(accessRequests)
    .set({ status, decidedAt: nowMs(), decidedBy: operator?.slice(0, 320) ?? null })
    .where(eq(accessRequests.id, id))
    .run();
  if (result.changes === 0) throw notFound("The access request");
  return { id, status };
}

/** For the operations summary. */
export function accessSummary() {
  const db = getDb();
  const pending = db
    .select({
      id: accessRequests.id,
      email: accessRequests.email,
      note: accessRequests.note,
      createdAt: accessRequests.createdAt,
    })
    .from(accessRequests)
    .where(eq(accessRequests.status, "pending"))
    .orderBy(asc(accessRequests.createdAt))
    .all();
  const total = db.select({ value: count() }).from(users).get()?.value ?? 0;
  return { counts: { users: total, pending_requests: pending.length }, pending_requests: pending };
}
