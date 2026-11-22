import { describe, expect, it } from "vitest";

import { decideAccess, isPublicPath, safeNext, type GateFacts } from "./access-gate";

const facts = (over: Partial<GateFacts>): GateFacts => ({
  path: "/sources",
  search: "",
  method: "GET",
  configured: true,
  access: null,
  ...over,
});

describe("decideAccess", () => {
  it("keeps exactly these paths public", () => {
    for (const path of ["/login", "/auth/error", "/api/health", "/api/auth/callback/google", "/api/admin/summary"]) {
      expect(isPublicPath(path), path).toBe(true);
    }
    for (const path of ["/", "/access", "/login/x", "/api", "/api/healthz", "/api/authx", "/api/other", "/settings", "/dev/kit", "/LOGIN"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it("refuses everything when sign-in is not configured", () => {
    for (const access of [null, "approved"] as const) {
      expect(decideAccess(facts({ configured: false, access }))).toEqual({ kind: "deny", status: 503 });
    }
    expect(decideAccess(facts({ configured: false, path: "/login" }))).toEqual({ kind: "allow" });
  });

  it("sends a visitor to the sign-in and keeps the page", () => {
    expect(decideAccess(facts({ path: "/" }))).toEqual({ kind: "redirect", to: "/login" });
    expect(decideAccess(facts({ path: "/f/a", search: "?w=day" }))).toEqual({ kind: "redirect", to: "/login?next=%2Ff%2Fa%3Fw%3Dday" });
    expect(decideAccess(facts({ path: "/access" }))).toMatchObject({ kind: "redirect" });
  });

  it("refuses a Server Action or an API call of a visitor", () => {
    expect(decideAccess(facts({ method: "POST" }))).toEqual({ kind: "deny", status: 401 });
    expect(decideAccess(facts({ path: "/api/other" }))).toEqual({ kind: "deny", status: 401 });
  });

  it("gives an account without approval the access page only", () => {
    for (const access of ["none", "pending", "denied"] as const) {
      expect(decideAccess(facts({ access }))).toEqual({ kind: "redirect", to: "/access" });
      expect(decideAccess(facts({ access, method: "POST" }))).toEqual({ kind: "deny", status: 403 });
      expect(decideAccess(facts({ access, path: "/access" }))).toEqual({ kind: "allow" });
      expect(decideAccess(facts({ access, path: "/access", method: "POST" }))).toEqual({ kind: "allow" });
    }
  });

  it("lets an approved account in", () => {
    expect(decideAccess(facts({ access: "approved" }))).toEqual({ kind: "allow" });
    expect(decideAccess(facts({ access: "approved", method: "POST" }))).toEqual({ kind: "allow" });
    expect(decideAccess(facts({ access: "approved", path: "/access" }))).toEqual({ kind: "redirect", to: "/" });
  });
});

describe("safeNext", () => {
  it("accepts a path of this site only", () => {
    expect(safeNext("/f/a?w=day")).toBe("/f/a?w=day");
    for (const bad of [undefined, "", "f/a", "//evil.example", "/\\evil.example", "https://evil.example", "/a\\b", "/a\nb", "/login", "/api/auth/signout", ["/a"]]) {
      expect(safeNext(bad), String(bad)).toBe("/");
    }
  });
});
