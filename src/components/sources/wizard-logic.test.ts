import { describe, expect, it } from "vitest";

import {
  bestCandidate,
  canReuseQualify,
  ownerForCreate,
  combinedSourceName,
  commonTypes,
  entriesFromParam,
  errorsAt,
  planEntries,
  splitEntries,
  typeFromParam,
  wizardHref,
  type ResolvedEntry,
  type WizardCandidate,
} from "./wizard-logic";

function candidate(type: WizardCandidate["type"], name: string, confidence: number, existing: WizardCandidate["existing"] = null): WizardCandidate {
  return { type, name, description: "", config: {}, confidence, existing };
}

describe("splitEntries", () => {
  it("takes one entry for each line and drops empty lines and duplicates", () => {
    expect(splitEntries("https://github.com/a/b\n\n  All-In  \nall-in\r\nagent evaluations\n")).toEqual([
      "https://github.com/a/b",
      "All-In",
      "agent evaluations",
    ]);
  });

  it("splits a line of comma-separated handles", () => {
    expect(splitEntries("@chamath, @sama,@naval")).toEqual(["@chamath", "@sama", "@naval"]);
    expect(splitEntries("chamath, sama", "x_user")).toEqual(["chamath", "sama"]);
  });

  it("keeps a topic with commas, a URL with commas, and plain words without the X user type", () => {
    expect(splitEntries("coding agents, evaluations")).toEqual(["coding agents, evaluations"]);
    expect(splitEntries("https://example.com/a,b")).toEqual(["https://example.com/a,b"]);
    expect(splitEntries("agents, evals")).toEqual(["agents, evals"]);
  });

  it("returns more than 10 entries so that the caller can say how many there are", () => {
    const text = Array.from({ length: 12 }, (_, i) => `@user${i}`).join("\n");
    expect(splitEntries(text)).toHaveLength(12);
  });
});

describe("query parameters of the wizard", () => {
  it("reads the entries and the type", () => {
    expect(entriesFromParam("@a\r\n@b")).toBe("@a\n@b");
    expect(entriesFromParam(["All-In", "Lex"])).toBe("All-In\nLex");
    expect(entriesFromParam(undefined)).toBe("");
    expect(entriesFromParam("x".repeat(30_000))).toHaveLength(20_000);
    expect(typeFromParam("podcast")).toBe("podcast");
    expect(typeFromParam("nope")).toBeNull();
    expect(typeFromParam(["x_user", "podcast"])).toBe("x_user");
  });

  it("builds the address of step 1", () => {
    expect(wizardHref({})).toBe("/sources/new");
    expect(wizardHref({ type: "x_user", entries: ["@a", "@b"], feed: "industry-radar" })).toBe(
      "/sources/new?type=x_user&feed=industry-radar&entries=%40a%0A%40b",
    );
  });
});

describe("several entries (§4.7 step 1)", () => {
  const chamath: ResolvedEntry = {
    input: "@chamath",
    candidates: [candidate("x_user", "@chamath", 0.95), candidate("x_search", "chamath", 0.3)],
  };
  const sama: ResolvedEntry = {
    input: "@sama",
    candidates: [candidate("x_user", "@sama", 0.9), candidate("x_search", "sama", 0.2)],
  };
  const nothing: ResolvedEntry = { input: "???", candidates: [], error: "No source was found." };

  it("finds the types that every resolved entry has, the most likely first", () => {
    expect(commonTypes([chamath, sama, nothing])).toEqual(["x_user", "x_search"]);
    expect(commonTypes([nothing])).toEqual([]);
  });

  it("takes the best candidate of a type", () => {
    const entry: ResolvedEntry = {
      input: "x",
      candidates: [candidate("podcast", "low", 0.2), candidate("podcast", "high", 0.8)],
    };
    expect(bestCandidate(entry, "podcast")?.name).toBe("high");
    expect(bestCandidate(entry, "blog")).toBeNull();
  });

  it("asks for the type when more than one common type has the same weight", () => {
    const a: ResolvedEntry = { input: "a", candidates: [candidate("x_search", "a", 0.5), candidate("web_search", "a", 0.5)] };
    const b: ResolvedEntry = { input: "b", candidates: [candidate("x_search", "b", 0.5), candidate("web_search", "b", 0.5)] };
    const plan = planEntries([a, b]);
    expect(plan.kind).toBe("choose_type");
    const chosen = planEntries([a, b], { chosen: "web_search" });
    expect(chosen.kind === "ready" && chosen.type).toBe("web_search");
  });

  it("is ready with one common type and lists the entries that did not resolve", () => {
    const plan = planEntries([chamath, sama, nothing], { forcedType: "x_user" });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.type).toBe("x_user");
    expect(plan.picks.map((p) => p.candidate.name)).toEqual(["@chamath", "@sama"]);
    expect(plan.unresolved).toEqual(["???"]);
    expect(plan.otherTypes).toEqual([]);
  });

  it("puts entries whose source exists aside", () => {
    const known: ResolvedEntry = {
      input: "@known",
      candidates: [candidate("x_user", "@known", 0.95, { id: 10, name: "@known" })],
    };
    const plan = planEntries([chamath, known], { forcedType: "x_user" });
    expect(plan.kind === "ready" && plan.picks.map((p) => p.input)).toEqual(["@chamath"]);
    expect(plan.kind === "ready" && plan.existing).toEqual([{ input: "@known", source: { id: 10, name: "@known" } }]);
  });

  it("says when the entries share no type", () => {
    const blog: ResolvedEntry = { input: "https://example.com", candidates: [candidate("blog", "Example", 0.9)] };
    expect(planEntries([chamath, blog]).kind).toBe("no_common_type");
    expect(planEntries([chamath, sama], { forcedType: "podcast" }).kind).toBe("no_common_type");
  });
});

describe("errorsAt", () => {
  it("takes the config errors of one entry", () => {
    const errors = {
      "entries.0.config.feedUrl": "Use an address.",
      "entries.0.config.sections.2": "Too long.",
      "entries.1.config.feedUrl": "Other entry.",
      "entries.0.config": "Not valid.",
      "common.why": "Say why.",
    };
    expect(errorsAt(errors, "entries.0.config")).toEqual({ feedUrl: "Use an address.", sections: "Too long.", _config: "Not valid." });
    expect(errorsAt(undefined, "config")).toEqual({});
  });
});

describe("combinedSourceName", () => {
  it("joins names and caps the length at 120", () => {
    expect(combinedSourceName(["@a"])).toBe("@a");
    expect(combinedSourceName(["@a", "@b"])).toBe("@a, @b");
    expect(combinedSourceName(Array.from({ length: 40 }, (_, i) => `@user${i}`))).toHaveLength(118);
  });
});

describe("ownerForCreate", () => {
  it("uses the name that the gate saved when the person did not edit the owner field", () => {
    expect(ownerForCreate("", false, "Dana")).toBe("Dana");
    expect(ownerForCreate("  ", false, "Dana")).toBe("Dana");
  });
  it("keeps what the person typed or cleared", () => {
    expect(ownerForCreate("Ana", false, "Dana")).toBe("Ana");
    expect(ownerForCreate("", true, "Dana")).toBe("");
    expect(ownerForCreate("", false, null)).toBe("");
  });
});

describe("canReuseQualify", () => {
  const ok = { available: true, perFeed: [] };
  it("reuses only a successful model check of the same input", () => {
    expect(canReuseQualify({ key: "k", result: ok, error: null }, "k")).toBe(true);
    expect(canReuseQualify({ key: "k", result: ok, error: null }, "other")).toBe(false);
    expect(canReuseQualify(null, "k")).toBe(false);
  });
  it("runs the check again after an unavailable model or an error", () => {
    expect(canReuseQualify({ key: "k", result: { available: false, unavailableReason: "paused", perFeed: [] }, error: null }, "k")).toBe(false);
    expect(canReuseQualify({ key: "k", result: null, error: "The model check did not reach the server." }, "k")).toBe(false);
  });
});
