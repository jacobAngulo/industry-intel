import { describe, expect, it } from "vitest";

import { feedbackSchema, relayFeedback, type FeedbackInput } from "./feedback";

const input: FeedbackInput = feedbackSchema.parse({
  kind: "bug",
  title: "  The digest is empty  ",
  description: "",
  submissionId: "sub-12345678",
  pageUrl: "https://example.test/industry-intel/f/radar",
  pageTitle: "Radar",
});

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("feedbackSchema", () => {
  it("trims the title and turns an empty description into null", () => {
    expect(input.title).toBe("The digest is empty");
    expect(input.description).toBeNull();
  });

  it("refuses an empty title and an unknown kind", () => {
    expect(feedbackSchema.safeParse({ ...input, title: "   " }).success).toBe(false);
    expect(feedbackSchema.safeParse({ ...input, kind: "praise" }).success).toBe(false);
  });
});

describe("relayFeedback", () => {
  const requester = { name: "Ada", userId: "client-1" };

  it("answers not_configured without a token and sends nothing", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await relayFeedback(input, requester, {}, fakeFetch(201, {}, calls));
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("posts to the project intake with the bearer token and an idempotency id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await relayFeedback(
      input,
      requester,
      { TICKET_BOARD_INTAKE_TOKEN: "tbi_test", TICKET_BOARD_URL: "http://board.test/" },
      fakeFetch(201, { identifier: "TB-7", duplicate: false }, calls),
    );
    expect(result).toEqual({ ok: true, identifier: "TB-7", duplicate: false });
    expect(calls[0]?.url).toBe("http://board.test/api/intake/industry-intel");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tbi_test");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.kind).toBe("bug");
    expect(body.requester).toEqual({ name: "Ada", contact: null, external_id: "client-1" });
    expect(body.source.external_id).toBe("sub-12345678");
  });

  it("reports a refusal with the detail of the board", async () => {
    const result = await relayFeedback(
      input,
      requester,
      { TICKET_BOARD_INTAKE_TOKEN: "tbi_test" },
      fakeFetch(403, { detail: "integration revoked" }),
    );
    expect(result).toEqual({ ok: false, reason: "rejected", detail: "integration revoked" });
  });

  it("reports unavailable when the board does not answer", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await relayFeedback(input, requester, { TICKET_BOARD_INTAKE_TOKEN: "tbi_test" }, failing);
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
