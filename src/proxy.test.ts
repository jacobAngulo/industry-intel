import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decideAccessRequest, getAccount, recordSignIn, submitAccessRequest } from "@/lib/services/users";
import { getSqlite } from "@/lib/db/client";
import { installTestDb } from "@/test/helpers";

import { proxy } from "./proxy";

const SECRET = "test-secret-test-secret-test-secret";
const COOKIE = "authjs.session-token";
let cleanup: () => void;

beforeEach(() => {
  cleanup = installTestDb().cleanup;
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_GOOGLE_ID", "id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

const cookieFor = async (sub: string, secret = SECRET, maxAge = 3600) =>
  `${COOKIE}=${await encode({ token: { sub }, secret, salt: COOKIE, maxAge })}`;
const get = (path: string, cookie?: string, method = "GET") =>
  proxy(new NextRequest(`http://localhost${path}`, { method, headers: cookie ? { cookie } : {} }));
const location = (res: Response) => new URL(res.headers.get("location")!, "http://localhost").pathname;
const requestId = () => (getSqlite().prepare("SELECT id FROM access_request").get() as { id: string }).id;

describe("proxy", () => {
  it("moves a person from the sign-in to the approval, and out again on a denial", async () => {
    expect(location(await get("/sources"))).toBe("/login");

    recordSignIn({ id: "g1", email: "Dana@Example.com", name: "Dana" });
    const cookie = await cookieFor("g1");
    expect(location(await get("/sources", cookie))).toBe("/access");

    submitAccessRequest("g1", "");
    expect(location(await get("/sources", cookie))).toBe("/access");

    decideAccessRequest(requestId(), "approve", "op@example.com");
    expect((await get("/sources", cookie)).headers.get("location")).toBeNull();
    expect((await get("/sources", cookie)).status).toBe(200);

    decideAccessRequest(requestId(), "deny", "op@example.com");
    expect(location(await get("/sources", cookie))).toBe("/access");
    expect((await get("/sources", cookie, "POST")).status).toBe(403);
  });

  it("does not trust a cookie with another secret, an old cookie, or an account that is gone", async () => {
    recordSignIn({ id: "g1", email: "dana@example.com" });
    submitAccessRequest("g1", "");
    decideAccessRequest(requestId(), "approve", null);
    expect(getAccount("g1")?.access).toBe("approved");

    expect(location(await get("/", await cookieFor("g1", "another-secret-another-secret-another")))).toBe("/login");
    expect(location(await get("/", await cookieFor("g1", SECRET, -3600)))).toBe("/login");
    expect(location(await get("/", await cookieFor("g2")))).toBe("/login");
    expect(location(await get("/", `${COOKIE}=garbage`))).toBe("/login");
    expect((await get("/", await cookieFor("g1"))).status).toBe(200);
  });

  it("refuses all when a setting is missing", async () => {
    for (const name of ["AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"]) {
      vi.stubEnv(name, "");
      expect((await get("/")).status, name).toBe(503);
      vi.stubEnv(name, SECRET);
    }
  });
});
