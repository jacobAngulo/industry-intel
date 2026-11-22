// Fails when a new page, action, or route has no access check. The lists are
// written again here, not imported: an imported list agrees with the code always.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const APP = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(APP, { recursive: true, encoding: "utf8" })
  .map((f) => f.split(path.sep).join("/"))
  .sort();
const read = (f: string) => readFileSync(path.join(APP, f), "utf8");

const PUBLIC_PAGES = ["access/page.tsx", "auth/error/page.tsx", "login/page.tsx"];
const ROUTES = [
  "api/admin/access-requests/[id]/decision/route.ts",
  "api/admin/summary/route.ts",
  "api/auth/[...nextauth]/route.ts",
  "api/health/route.ts",
];
/** They need no access: the sign-in, the sign-out, and the request itself (it checks the session). */
const OPEN_ACTIONS = ["signInAction", "signOutAction", "submitAccessRequestAction"];

describe("access checks", () => {
  it("every page except the public ones calls requireUser", () => {
    const open = files.filter((f) => /(^|\/)page\.tsx$/.test(f) && !read(f).includes("requireUser()"));
    expect(open).toEqual(PUBLIC_PAGES);
  });

  it("every Server Action goes through withActor or withAdmin", () => {
    const open: string[] = [];
    let count = 0;
    for (const file of files.filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      const text = read(file);
      if (!/^"use server";/m.test(text)) continue;
      const bodies = text.split(/^export async function /m).slice(1);
      for (const body of bodies) {
        count += 1;
        if (!/\bwith(Actor|Admin)(<[^(]*>)?\(/.test(body)) open.push(/^\w+/.exec(body)![0]);
      }
    }
    expect(open.sort()).toEqual(OPEN_ACTIONS);
    expect(count).toBeGreaterThan(30);
  });

  it("only the shared settings that are dangerous need an administrator", () => {
    const admin = read("settings/actions.ts")
      .split(/^export async function /m)
      .slice(1)
      .filter((body) => body.includes("withAdmin("))
      .map((body) => /^\w+/.exec(body)![0]);
    expect(admin.sort()).toEqual(["deleteFeedAction", "removeKeyAction", "saveKeyAction"]);
  });

  it("has no unknown route handler", () => {
    expect(files.filter((f) => /(^|\/)route\.ts$/.test(f))).toEqual(ROUTES);
  });
});
