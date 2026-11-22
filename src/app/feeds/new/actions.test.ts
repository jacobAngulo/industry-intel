import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/lib/services";

const revalidatePath = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT ${url}`);
});
const getUser = vi.fn();
const createFeed = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/app/_lib/identity", () => ({ getUser: () => getUser() }));
vi.mock("@/lib/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services")>()),
  createFeed: (...args: unknown[]) => createFeed(...args),
}));

const { createFeedAction } = await import("./actions");

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  for (const fn of [revalidatePath, redirect, getUser, createFeed]) fn.mockClear();
  getUser.mockResolvedValue({ id: "c1", name: "Ana" });
});

describe("createFeedAction", () => {
  it("creates the feed and opens its source settings", async () => {
    createFeed.mockResolvedValue({ slug: "security-watch" });
    await expect(createFeedAction(null, form({ name: " Security Watch ", purpose: "CVEs" }))).rejects.toThrow(
      "REDIRECT /f/security-watch/settings/sources",
    );
    expect(createFeed).toHaveBeenCalledWith({ name: "Security Watch", purpose: "CVEs" }, { name: "Ana", userId: "c1" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("returns field errors and keeps the typed values", async () => {
    const state = await createFeedAction(null, form({ name: "  ", purpose: "p" }));
    expect(state.result).toMatchObject({ ok: false, code: "validation", fieldErrors: { name: "Enter a name for the feed." } });
    expect(state.values).toEqual({ name: "  ", purpose: "p" });
    expect(createFeed).not.toHaveBeenCalled();
  });

  it("shows the limit error of the service", async () => {
    createFeed.mockRejectedValue(new ServiceError("limit", "The app has 30 feeds, the maximum."));
    const state = await createFeedAction(null, form({ name: "One more" }));
    expect(state.result).toEqual({ ok: false, code: "limit", message: "The app has 30 feeds, the maximum." });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    getUser.mockResolvedValue(null);
    const state = await createFeedAction(null, form({ name: "X" }));
    expect(state.result).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
