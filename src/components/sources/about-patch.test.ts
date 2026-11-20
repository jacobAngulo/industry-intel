import { describe, expect, it } from "vitest";

import { aboutPatch } from "./about-patch";

const base = { name: "Foundry", why: "Affects us.", owner: "Ana", interval: "60" };

describe("aboutPatch", () => {
  it("has only the fields that differ from the values that the form saw", () => {
    expect(aboutPatch(base, { ...base, interval: "120" })).toEqual({ checkIntervalMinutes: 120 });
    expect(aboutPatch(base, { ...base, name: "Foundry docs", owner: "  " })).toEqual({ name: "Foundry docs", owner: null });
    expect(aboutPatch(base, base)).toEqual({});
  });

  it("ignores white space at the ends", () => {
    expect(aboutPatch(base, { ...base, why: " Affects us. ", owner: "Ana " })).toEqual({});
  });
});
