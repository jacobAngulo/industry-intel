import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAccount, recordSignIn, submitAccessRequest } from "@/lib/services";
import { getSqlite } from "@/lib/db/client";
import { installTestDb } from "@/test/helpers";

import { POST } from "./access-requests/[id]/decision/route";
import { GET } from "./summary/route";

const TOKEN = "t".repeat(40);
let cleanup: () => void;
beforeEach(() => {
  cleanup = installTestDb().cleanup;
  vi.stubEnv("ADMIN_API_TOKEN", TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

const req = (token: string | null, body?: unknown) =>
  new Request("http://127.0.0.1/api/admin", {
    method: body === undefined ? "GET" : "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const decide = (id: string, token: string | null, body: unknown) => POST(req(token, body), { params: Promise.resolve({ id }) });

describe("/api/admin", () => {
  it("refuses a missing, wrong, or short token", async () => {
    expect(GET(req(null)).status).toBe(401);
    expect(GET(req("wrong")).status).toBe(401);
    expect((await decide("x", null, { decision: "approve" })).status).toBe(401);
    vi.stubEnv("ADMIN_API_TOKEN", "short");
    expect(GET(req("short")).status).toBe(401);
    vi.stubEnv("ADMIN_API_TOKEN", "");
    expect(GET(req("")).status).toBe(401);
  });

  it("decides a request", async () => {
    recordSignIn({ id: "g1", email: "dana@example.com" });
    submitAccessRequest("g1", "");
    const { id } = getSqlite().prepare("SELECT id FROM access_request").get() as { id: string };
    expect((await decide(id, TOKEN, { decision: "maybe" })).status).toBe(400);
    expect((await decide("nope", TOKEN, { decision: "approve" })).status).toBe(404);
    expect(getAccount("g1")?.access).toBe("pending");
    const res = await decide(id, TOKEN, { decision: "approve", operator: null });
    expect(await res.json()).toEqual({ id, status: "approved" });
    expect(getAccount("g1")?.access).toBe("approved");
    expect(await GET(req(TOKEN)).json()).toMatchObject({ counts: { users: 1, pending_requests: 0 } });
  });
});
