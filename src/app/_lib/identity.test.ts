import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import {
  CLIENT_COOKIE,
  CLIENT_HEADER,
  COOKIE_MAX_AGE_SECONDS,
  NAME_COOKIE,
  cleanDisplayName,
  isValidClientId,
} from "./identity-constants";

// next/headers is replaced by a fake request store.
const store = { cookies: new Map<string, string>(), headers: new Map<string, string>() };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (store.cookies.has(name) ? { name, value: store.cookies.get(name) } : undefined),
  }),
  headers: async () => ({ get: (name: string) => store.headers.get(name.toLowerCase()) ?? null }),
}));

const { getActor, requireActor } = await import("./identity");
const { proxy } = await import("@/proxy");

const UUID_A = "0b6f4f3e-8a1d-4c2b-9f00-123456789abc";
const UUID_B = "1c7a5e4f-9b2e-4d3c-8a11-abcdefabcdef";

describe("identity rules", () => {
  it("accepts a UUID only", () => {
    expect(isValidClientId(UUID_A)).toBe(true);
    expect(isValidClientId(crypto.randomUUID())).toBe(true);
    expect(isValidClientId("abc")).toBe(false);
    expect(isValidClientId("")).toBe(false);
    expect(isValidClientId(null)).toBe(false);
    expect(isValidClientId(`${UUID_A}x`)).toBe(false);
  });

  it("cleans a display name", () => {
    expect(cleanDisplayName("  Sam   Lee ")).toBe("Sam Lee");
    expect(cleanDisplayName("Sam​‮")).toBe("Sam");
    expect(cleanDisplayName("a\nb")).toBe("ab");
    expect(cleanDisplayName("   ")).toBeNull();
    expect(cleanDisplayName("x".repeat(60))).toBe("x".repeat(60));
    expect(cleanDisplayName("x".repeat(61))).toBeNull();
    expect(cleanDisplayName(undefined)).toBeNull();
  });
});

describe("getActor / requireActor", () => {
  beforeEach(() => {
    store.cookies.clear();
    store.headers.clear();
  });

  it("prefers the proxy header, then the cookie", async () => {
    store.headers.set(CLIENT_HEADER, UUID_A);
    store.cookies.set(CLIENT_COOKIE, UUID_B);
    expect(await getActor()).toEqual({ name: null, clientId: UUID_A });
    store.headers.clear();
    expect(await getActor()).toEqual({ name: null, clientId: UUID_B });
  });

  it("ignores invalid ids and reads the name cookie", async () => {
    store.headers.set(CLIENT_HEADER, "forged");
    store.cookies.set(NAME_COOKIE, "  Sam ");
    expect(await getActor()).toEqual({ name: "Sam", clientId: "" });
  });

  it("requireActor: null without a name when needed; 'Someone' otherwise", async () => {
    store.headers.set(CLIENT_HEADER, UUID_A);
    expect(await requireActor(true)).toBeNull();
    expect(await requireActor(false)).toEqual({ name: "Someone", clientId: UUID_A });
    store.cookies.set(NAME_COOKIE, "Sam");
    expect(await requireActor(true)).toEqual({ name: "Sam", clientId: UUID_A });
  });
});

describe("proxy", () => {
  it("sets ii_client on a request with no cookie and passes it in x-ii-client", () => {
    const res = proxy(new NextRequest("http://localhost:4430/"));
    const cookie = res.cookies.get(CLIENT_COOKIE);
    expect(cookie).toBeDefined();
    expect(isValidClientId(cookie?.value)).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.maxAge).toBe(COOKIE_MAX_AGE_SECONDS);
    expect(cookie?.path).toBe("/");
    // The forwarded request header (Next.js encodes it as x-middleware-request-*).
    expect(res.headers.get(`x-middleware-request-${CLIENT_HEADER}`)).toBe(cookie?.value);
  });

  it("keeps a valid cookie, sets no new cookie, and overwrites a forged header", () => {
    const req = new NextRequest("http://localhost:4430/sources", {
      headers: { cookie: `${CLIENT_COOKIE}=${UUID_A}`, [CLIENT_HEADER]: UUID_B },
    });
    const res = proxy(req);
    expect(res.cookies.get(CLIENT_COOKIE)).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get(`x-middleware-request-${CLIENT_HEADER}`)).toBe(UUID_A);
  });

  it("replaces an invalid cookie value", () => {
    const res = proxy(new NextRequest("http://localhost:4430/", { headers: { cookie: `${CLIENT_COOKIE}=nope` } }));
    const value = res.cookies.get(CLIENT_COOKIE)?.value;
    expect(isValidClientId(value)).toBe(true);
  });
});
