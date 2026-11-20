// HTTP helpers of the github connector: one request through ctx.http, and the
// mapping of transport errors and GitHub status codes to ConnectorError.
import { HttpError, type HttpRequest, type HttpResponse } from "@/lib/http/types";

import { ConnectorError, type ConnectorContext } from "../types";

/** The REST headers that GitHub documents for API version 2022-11-28. */
export const GITHUB_API_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** Sends one request. An HttpError becomes a ConnectorError with a message for people. */
export async function send(ctx: ConnectorContext, req: HttpRequest, what: string): Promise<HttpResponse> {
  try {
    return await ctx.http.request({ ...req, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (error) {
    throw transportError(error, what);
  }
}

export function transportError(error: unknown, what: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof HttpError) {
    switch (error.kind) {
      case "timeout":
        return new ConnectorError("network", `${what} did not answer in time.`, { cause: error });
      case "too_large":
        return new ConnectorError("bad_response", `${what} sent a response that is too large.`, { cause: error });
      case "too_many_redirects":
        return new ConnectorError("bad_response", `${what} redirected too many times.`, { cause: error });
      case "bad_url":
      case "blocked_address":
        return new ConnectorError("blocked", `The app does not send requests to this address (${what}).`, { cause: error });
      default:
        return new ConnectorError("network", `${what} could not be reached.`, { cause: error });
    }
  }
  return new ConnectorError("network", `${what} could not be reached.`, { cause: error });
}

/** "14:05 UTC" or "21 Nov 14:05 UTC" when the reset time is not today (UTC). */
function formatReset(resetMs: number, nowMs: number): string {
  const reset = new Date(resetMs);
  const time = `${reset.toISOString().slice(11, 16)} UTC`;
  if (reset.toISOString().slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10)) return time;
  const day = reset.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day} ${time}`;
}

/**
 * The rate-limit error of a GitHub API response, or null. GitHub answers 403 or 429 when a limit is
 * used: the primary limit has x-ratelimit-remaining 0 and x-ratelimit-reset (epoch seconds); a
 * secondary limit has retry-after (seconds).
 */
export function rateLimitError(res: HttpResponse, nowMs: number, what: string): ConnectorError | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const remaining = res.headers["x-ratelimit-remaining"];
  const reset = Number(res.headers["x-ratelimit-reset"]);
  const retryAfter = Number(res.headers["retry-after"]);
  let resetMs: number | null = null;
  if (Number.isFinite(retryAfter) && retryAfter > 0) resetMs = nowMs + retryAfter * 1000;
  else if (remaining === "0" && Number.isFinite(reset) && reset > 0) resetMs = reset * 1000;
  if (resetMs === null && res.status === 403 && remaining !== "0") return null;
  const when = resetMs !== null ? ` The limit resets at ${formatReset(resetMs, nowMs)}.` : "";
  return new ConnectorError("rate_limited", `GitHub limits the requests of this server (${what}).${when}`);
}

/** The error for a status code that is not 2xx or 304. */
export function statusError(res: HttpResponse, nowMs: number, what: string, notFound: string): ConnectorError {
  const limited = rateLimitError(res, nowMs, what);
  if (limited) return limited;
  if (res.status === 404 || res.status === 410) return new ConnectorError("not_found", notFound);
  if (res.status === 401) return new ConnectorError("needs_credentials", `GitHub refused the token (${what}). Check GITHUB_TOKEN.`);
  if (res.status === 403 || res.status === 451) return new ConnectorError("blocked", `GitHub refused the request (${what}, status ${res.status}).`);
  return new ConnectorError("bad_response", `GitHub answered with status ${res.status} (${what}).`);
}
