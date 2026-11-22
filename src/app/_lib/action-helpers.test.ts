import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Account } from "@/lib/services/users";

const getUser = vi.fn<() => Promise<Account | null>>();
vi.mock("./identity", () => ({ getUser: () => getUser() }));

const { fail, formToObject, ok, parseForm, parseInput, withActor, withAdmin, zodFieldErrors, VALIDATION_MESSAGE } =
  await import("./action-helpers");

describe("ok / fail", () => {
  it("builds a success result, with and without a message", () => {
    expect(ok(5)).toEqual({ ok: true, data: 5 });
    expect(ok({ id: 1 }, "Saved")).toEqual({ ok: true, data: { id: 1 }, message: "Saved" });
  });

  it("builds a failure result and leaves out empty parts", () => {
    expect(fail("No")).toEqual({ ok: false, message: "No" });
    expect(fail("No", "not_found")).toEqual({ ok: false, message: "No", code: "not_found" });
    expect(fail("No", "validation", {})).toEqual({ ok: false, message: "No", code: "validation" });
    expect(fail("No", "validation", { name: "Too long" })).toEqual({
      ok: false,
      message: "No",
      code: "validation",
      fieldErrors: { name: "Too long" },
    });
  });
});

describe("formToObject", () => {
  it("keeps text values, makes arrays of repeated keys, drops files and $ACTION fields", () => {
    const fd = new FormData();
    fd.append("name", "Radar");
    fd.append("tag", "a");
    fd.append("tag", "b");
    fd.append("$ACTION_ID_abc", "");
    fd.append("$ACTION_REF_1", "");
    fd.append("upload", new Blob(["x"]), "x.txt");
    expect(formToObject(fd)).toEqual({ name: "Radar", tag: ["a", "b"] });
  });

  it("always gives an array for the keys in `arrays`, also with zero or one value", () => {
    const fd = new FormData();
    fd.append("feedIds", "3");
    expect(formToObject(fd, { arrays: ["feedIds", "exclusions"] })).toEqual({ feedIds: ["3"], exclusions: [] });
  });
});

describe("parseInput / parseForm", () => {
  const schema = z.object({
    name: z.string().min(1, { error: "Enter a name." }).max(5, { error: "Too long." }),
    digest: z.object({ time: z.string().regex(/^\d\d:\d\d$/, { error: "Use HH:MM." }) }),
  });

  it("returns the parsed data", () => {
    expect(parseInput(schema, { name: "abc", digest: { time: "08:30" } })).toEqual({
      ok: true,
      data: { name: "abc", digest: { time: "08:30" } },
    });
  });

  it("returns field errors keyed by the dotted path, first message only", () => {
    const result = parseInput(schema, { name: "", digest: { time: "8" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation");
    expect(result.message).toBe(VALIDATION_MESSAGE);
    expect(result.fieldErrors).toEqual({ name: "Enter a name.", "digest.time": "Use HH:MM." });
  });

  it("uses the message of a form-level error when it is the only error", () => {
    const refined = z.object({ a: z.string() }).refine((v) => v.a !== "x", { error: "Not x." });
    const result = parseInput(refined, { a: "x" });
    expect(result).toEqual({ ok: false, message: "Not x.", code: "validation", fieldErrors: { _form: "Not x." } });
  });

  it("parseForm reads FormData with coercion in the schema", () => {
    const formSchema = z.object({ minRelevance: z.coerce.number().int().min(0).max(100), on: z.literal("on").optional() });
    const fd = new FormData();
    fd.append("minRelevance", "70");
    expect(parseForm(formSchema, fd)).toEqual({ ok: true, data: { minRelevance: 70 } });
    fd.set("minRelevance", "170");
    const bad = parseForm(formSchema, fd);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors ?? {})).toEqual(["minRelevance"]);
  });

  it("zodFieldErrors maps an empty path to _form", () => {
    const r = z.string().safeParse(1);
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(zodFieldErrors(r.error))).toEqual(["_form"]);
  });
});

const sam: Account = { id: "g1", email: "sam@example.com", name: "Sam", access: "approved", isAdmin: false };

describe("withActor / withAdmin", () => {
  beforeEach(() => getUser.mockReset());

  it("refuses without a signed-in person and does not run fn", async () => {
    getUser.mockResolvedValue(null);
    const fn = vi.fn(async () => ok(1));
    expect(await withActor(fn)).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await withAdmin(fn)).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes the actor to fn and returns its result", async () => {
    getUser.mockResolvedValue(sam);
    expect(await withActor((actor) => ok(actor))).toEqual({ ok: true, data: { userId: "g1", name: "Sam" } });
  });

  it("withAdmin refuses a person who is not an administrator", async () => {
    getUser.mockResolvedValue(sam);
    const fn = vi.fn(async () => ok(1));
    expect(await withAdmin(fn)).toMatchObject({ ok: false, code: "forbidden" });
    expect(fn).not.toHaveBeenCalled();
    getUser.mockResolvedValue({ ...sam, isAdmin: true });
    expect(await withAdmin(fn)).toEqual({ ok: true, data: 1 });
  });
});
