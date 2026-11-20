// HTTP helpers that the feed-based connectors share (blog, newsletter,
// podcast, youtube). Every request goes through ctx.http (§11.1). Each error
// becomes a ConnectorError with a message that is fit to show to a person.
import { HttpError, type HttpRequest, type HttpResponse } from "@/lib/http/types";

import { ConnectorError, type ConnectorContext } from "../types";

export const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5";
export const PAGE_ACCEPT = "text/html, application/xhtml+xml;q=0.9, */*;q=0.5";

export interface GetOptions {
  accept?: string;
  etag?: string;
  lastModified?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/** A GET through ctx.http. HttpError (and an abort) becomes a ConnectorError. HTTP status codes do not throw. */
export async function httpGet(ctx: ConnectorContext, url: string, options: GetOptions = {}): Promise<HttpResponse> {
  const req: HttpRequest = { url, method: "GET", headers: { accept: options.accept ?? PAGE_ACCEPT } };
  if (options.etag) req.etag = options.etag;
  if (options.lastModified) req.lastModified = options.lastModified;
  if (options.maxBytes !== undefined) req.maxBytes = options.maxBytes;
  if (options.timeoutMs !== undefined) req.timeoutMs = options.timeoutMs;
  if (ctx.signal) req.signal = ctx.signal;
  try {
    return await ctx.http.request(req);
  } catch (error) {
    throw toConnectorError(error, url, ctx.signal);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the site";
  }
}

/** Maps an error of ctx.http (or an abort) to a ConnectorError. A ConnectorError stays as it is. */
export function toConnectorError(error: unknown, url: string, signal?: AbortSignal): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const host = hostOf(url);
  if (error instanceof HttpError) {
    switch (error.kind) {
      case "timeout":
        return new ConnectorError("network", `${host} did not answer in time.`, { cause: error });
      case "network":
        return new ConnectorError("network", `The app could not reach ${host}.`, { cause: error });
      case "blocked_address":
        return new ConnectorError(
          "blocked",
          `The address of ${host} is a private or local network address. The app does not fetch such addresses.`,
          { cause: error },
        );
      case "bad_url":
        return new ConnectorError("not_found", "The address is not a valid http or https address.", { cause: error });
      case "too_large":
        return new ConnectorError("bad_response", `The answer of ${host} is larger than the size limit.`, { cause: error });
      case "too_many_redirects":
        return new ConnectorError("bad_response", `The address at ${host} redirects too many times.`, { cause: error });
    }
  }
  if (signal?.aborted) {
    return new ConnectorError("network", "The check was stopped because it took too long.", { cause: error });
  }
  return new ConnectorError("network", `The request to ${host} failed.`, { cause: error });
}

/**
 * Throws a ConnectorError when the status is not 2xx (304 counts as fine).
 * `what` names the thing that the address should give, for example "The feed address".
 */
export function assertOk(res: HttpResponse, what: string): void {
  if (res.notModified || res.status === 304) return;
  if (res.status >= 200 && res.status < 300) return;
  const s = res.status;
  if (s === 404 || s === 410) throw new ConnectorError("not_found", `${what} returned ${s}. Check the address.`);
  if (s === 401 || s === 403 || s === 451) {
    throw new ConnectorError("blocked", `${what} refused the request (${s}).`);
  }
  if (s === 429) throw new ConnectorError("rate_limited", `${what} asks the app to slow down (429). The app tries again later.`);
  if (s >= 500) throw new ConnectorError("network", `${what} had an error (${s}). The app tries again later.`);
  throw new ConnectorError("bad_response", `${what} answered with status ${s}.`);
}

/**
 * The http(s) URL that a person typed, or null. A bare domain ("example.com/blog")
 * becomes https. Angle brackets and a trailing dot or comma are removed.
 */
export function inputUrl(input: string): URL | null {
  let text = input.trim().replace(/^<(.*)>$/, "$1").replace(/[.,;]+$/, "");
  if (text === "" || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) {
    if (text.includes("@") || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(text)) {
      return null;
    }
    text = `https://${text}`;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** The host without "www." and in lower case. */
export function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/** The value of a <meta property|name="…" content="…"> tag, with entities decoded by the caller. */
export function metaContent(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key === undefined || !new RegExp(`^${escaped}$`, "i").test(key.trim())) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tag)?.[1];
    if (content !== undefined) return content;
  }
  return undefined;
}

/** "18 Nov 2026" for a description line. */
export function shortDate(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(ms);
}
