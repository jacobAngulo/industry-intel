import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSqlite } from "@/lib/db/client";
import { installTestDb } from "@/test/helpers";

import { ServiceError } from "./_manage-errors";
import { accessSummary, decideAccessRequest, getAccount, isAdminEmail, recordSignIn, submitAccessRequest } from "./users";

let cleanup: () => void;
beforeEach(() => {
  cleanup = installTestDb().cleanup;
});
afterEach(() => cleanup());

const row = () => getSqlite().prepare("SELECT * FROM access_request").get() as Record<string, unknown>;

describe("accounts and access", () => {
  it("a sign-in stores the account and gives no access", () => {
    recordSignIn({ id: "g1", email: " Dana@Example.com ", name: " Dana   Lee " });
    expect(getAccount("g1")).toEqual({ id: "g1", email: "dana@example.com", name: "Dana Lee", access: "none", isAdmin: false });
    recordSignIn({ id: "g1", email: "new@example.com", name: null });
    expect(getAccount("g1")).toMatchObject({ email: "new@example.com", name: "new" });
    expect(getAccount("g2")).toBeNull();
    expect(() => recordSignIn({ id: "g3", email: "nope" })).toThrow(ServiceError);
  });

  it("a new sign-in does not change the access", () => {
    recordSignIn({ id: "g1", email: "dana@example.com" });
    submitAccessRequest("g1", "");
    decideAccessRequest(String(row().id), "deny", null);
    recordSignIn({ id: "g1", email: "dana@example.com" });
    expect(getAccount("g1")?.access).toBe("denied");
  });

  it("a request stays one row: pending and approved do not change, denied becomes pending", () => {
    recordSignIn({ id: "g1", email: "dana@example.com" });
    expect(submitAccessRequest("g1", " hello ")).toBe("pending");
    expect(submitAccessRequest("g1", "again")).toBe("pending");
    expect(row()).toMatchObject({ note: "hello", email: "dana@example.com" });
    expect(accessSummary().pending_requests).toHaveLength(1);

    decideAccessRequest(String(row().id), "approve", "op@example.com");
    expect(row()).toMatchObject({ status: "approved", decided_by: "op@example.com" });
    expect(submitAccessRequest("g1", "x")).toBe("approved");

    decideAccessRequest(String(row().id), "deny", null);
    expect(submitAccessRequest("g1", "please")).toBe("pending");
    expect(row()).toMatchObject({ status: "pending", note: "please", decided_at: null, decided_by: null });
    expect(accessSummary().counts).toEqual({ users: 1, pending_requests: 1 });
  });

  it("refuses an unknown account, an unknown request, and a long note", () => {
    expect(() => submitAccessRequest("g9", "")).toThrow(ServiceError);
    expect(() => decideAccessRequest("nope", "approve", null)).toThrow(ServiceError);
    recordSignIn({ id: "g1", email: "dana@example.com" });
    expect(() => submitAccessRequest("g1", "x".repeat(501))).toThrow(ServiceError);
  });

  it("ADMIN_EMAILS: a bad list has no administrators", () => {
    expect(isAdminEmail("a@x.io", "b@x.io, A@x.io")).toBe(true);
    expect(isAdminEmail("a@x.io", "b@x.io")).toBe(false);
    expect(isAdminEmail("a@x.io", "a@x.io, oops")).toBe(false);
    expect(isAdminEmail("a@x.io", "")).toBe(false);
    expect(isAdminEmail("a@x.io", undefined)).toBe(false);
  });
});
