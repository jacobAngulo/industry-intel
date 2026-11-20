import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseOrThrow, requireName, ServiceError, serviceFailure } from "./_manage-errors";

describe("the error pattern of the services", () => {
  it("parseOrThrow gives a validation error with the field errors", () => {
    const schema = z.object({ name: z.string().min(1), digest: z.object({ time: z.string().regex(/^\d\d:\d\d$/) }) });
    expect(parseOrThrow(schema, { name: "A", digest: { time: "08:30" } })).toEqual({ name: "A", digest: { time: "08:30" } });
    try {
      parseOrThrow(schema, { name: "", digest: { time: "8" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe("validation");
      expect(Object.keys((error as ServiceError).fieldErrors ?? {})).toEqual(["name", "digest.time"]);
    }
  });

  it("serviceFailure maps a ServiceError to a failure result and throws other errors again", () => {
    expect(serviceFailure(new ServiceError("conflict", "Archive it first."))).toEqual({ ok: false, message: "Archive it first.", code: "conflict" });
    expect(serviceFailure(new ServiceError("validation", "Bad.", { name: "Too long." }))).toEqual({
      ok: false,
      message: "Bad.",
      code: "validation",
      fieldErrors: { name: "Too long." },
    });
    const bug = new Error("bug");
    expect(() => serviceFailure(bug)).toThrow(bug);
  });

  it("requireName refuses an empty name and the anonymous name", () => {
    expect(() => requireName({ name: "Dana", clientId: "c" })).not.toThrow();
    for (const name of ["", "  ", "Someone", "someone "]) {
      expect(() => requireName({ name, clientId: "c" })).toThrow(ServiceError);
    }
  });
});
