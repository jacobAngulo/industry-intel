import { describe, expect, it } from "vitest";

import { setNowForTests } from "@/test/helpers";

import { errorBodyText, errorForStatus, parseRetryAfter, safeText } from "./errors";
import { extractJsonValue } from "./extract";

describe("extractJsonValue", () => {
  it("reads plain JSON, a fence, and the first balanced object in prose", () => {
    expect(extractJsonValue('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJsonValue('```json\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } });
    expect(extractJsonValue('```\n{"a":3}\n```')).toEqual({ ok: true, value: { a: 3 } });
    expect(extractJsonValue('Sure! {"a":{"b":"}"}} Done {"c":1}')).toEqual({ ok: true, value: { a: { b: "}" } } });
    expect(extractJsonValue('I think {so} but {"a":4}')).toEqual({ ok: true, value: { a: 4 } });
    expect(extractJsonValue('<think>{"x":0}</think>{"a":5}')).toEqual({ ok: true, value: { a: 5 } });
  });

  it("fails for an empty reply, prose, or a cut object", () => {
    expect(extractJsonValue("  ")).toMatchObject({ ok: false });
    expect(extractJsonValue("No JSON here.")).toMatchObject({ ok: false });
    expect(extractJsonValue('{"facts":{"headline":"Orbix')).toMatchObject({ ok: false });
  });
});

describe("errors", () => {
  it("reads the error text of both body shapes and raw text", () => {
    expect(errorBodyText('{"error":"Unauthorized"}')).toBe("Unauthorized");
    expect(errorBodyText('{"error":{"message":"not found"}}')).toBe("not found");
    expect(errorBodyText("plain")).toBe("plain");
  });

  it("removes the key and keeps one short line", () => {
    expect(safeText("a\n b key123 c", "key123")).toBe("a b [key] c");
    expect(safeText("x".repeat(500), undefined, 10)).toHaveLength(10);
  });

  it("parses Retry-After in seconds and as a date", () => {
    setNowForTests(Date.parse("2026-11-20T10:00:00Z"));
    try {
      expect(parseRetryAfter("12")).toBe(12_000);
      expect(parseRetryAfter("Fri, 20 Nov 2026 10:01:00 GMT")).toBe(60_000);
      expect(parseRetryAfter("soon")).toBeUndefined();
      expect(parseRetryAfter(undefined)).toBeUndefined();
    } finally {
      setNowForTests(null);
    }
  });

  it("maps the statuses of §20", () => {
    const kind = (status: number) => errorForStatus({ status, body: "", headers: {}, what: "X", key: undefined }).kind;
    expect([401, 402, 403, 404, 400, 429, 500, 502, 503, 504, 529].map(kind)).toEqual([
      "auth",
      "payment",
      "auth",
      "not_found",
      "bad_request",
      "rate_limited",
      "overloaded",
      "overloaded",
      "overloaded",
      "overloaded",
      "overloaded",
    ]);
  });
});
