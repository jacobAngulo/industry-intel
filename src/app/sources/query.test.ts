import { describe, expect, it } from "vitest";

import { directoryHref, hasFilters, parseDirectoryQuery } from "./query";

describe("parseDirectoryQuery", () => {
  it("reads the filters and drops unknown values", () => {
    expect(parseDirectoryQuery({ type: "podcast", status: "failing", feed: "2", owner: "me", q: " agent ", sort: "useful" })).toEqual({
      type: "podcast",
      status: "failing",
      feed: "2",
      ownerMe: true,
      q: "agent",
      sort: "useful",
    });
    expect(parseDirectoryQuery({ type: "rss", status: "broken", feed: "<x>", owner: "you", sort: "random" })).toEqual({
      type: null,
      status: null,
      feed: null,
      ownerMe: false,
      q: "",
      sort: "name",
    });
    expect(parseDirectoryQuery({ type: ["x_user", "podcast"], q: "x".repeat(500) }).q).toHaveLength(120);
  });
});

describe("directoryHref", () => {
  const query = parseDirectoryQuery({ type: "x_user", status: "active", q: "a b", sort: "last_check" });

  it("keeps the other parameters when one changes", () => {
    expect(directoryHref(query, { type: "podcast" })).toBe("/sources?type=podcast&status=active&q=a+b&sort=last_check");
    expect(directoryHref(query, { type: null })).toBe("/sources?status=active&q=a+b&sort=last_check");
    expect(directoryHref(parseDirectoryQuery({}))).toBe("/sources");
  });

  it("knows when a filter is set", () => {
    expect(hasFilters(query)).toBe(true);
    expect(hasFilters(parseDirectoryQuery({ type: "podcast", sort: "useful" }))).toBe(false);
  });
});
