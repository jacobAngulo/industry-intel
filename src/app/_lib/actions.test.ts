import { beforeEach, describe, expect, it, vi } from "vitest";

import { COOKIE_MAX_AGE_SECONDS, NAME_COOKIE } from "./identity-constants";

const setCookie = vi.fn();
const revalidatePath = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ set: setCookie }) }));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const { setName } = await import("./actions");

describe("setName", () => {
  beforeEach(() => {
    setCookie.mockReset();
    revalidatePath.mockReset();
  });

  it("stores a cleaned name in an httpOnly cookie for one year", async () => {
    const result = await setName("  Sam   Lee ");
    expect(result).toEqual({ ok: true, data: { name: "Sam Lee" }, message: "Saved" });
    expect(setCookie).toHaveBeenCalledWith(
      expect.objectContaining({
        name: NAME_COOKIE,
        value: "Sam Lee",
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: COOKIE_MAX_AGE_SECONDS,
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("reads the field `name` of FormData", async () => {
    const fd = new FormData();
    fd.set("name", "Ana");
    expect(await setName(fd)).toEqual({ ok: true, data: { name: "Ana" }, message: "Saved" });
  });

  it("refuses an empty or too long name and sets no cookie", async () => {
    const empty = await setName("   ");
    expect(empty).toMatchObject({ ok: false, code: "validation", fieldErrors: { name: "Enter your name." } });
    const long = await setName("x".repeat(61));
    expect(long).toMatchObject({ ok: false, code: "validation" });
    const missing = await setName(new FormData());
    expect(missing.ok).toBe(false);
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("refuses the anonymous name 'Someone' in any case, because every service rejects it", async () => {
    for (const value of ["Someone", " someone ", "SOMEONE"]) {
      const result = await setName(value);
      expect(result).toMatchObject({
        ok: false,
        code: "validation",
        fieldErrors: { name: "Use your own name, not 'Someone'." },
      });
    }
    expect(setCookie).not.toHaveBeenCalled();
    expect((await setName("Someone Else")).ok).toBe(true);
  });
});
