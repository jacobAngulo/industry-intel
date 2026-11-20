// SafeHttp (specification §11.1 and §14): every outbound HTTP request of the
// app goes through it.
//
// Protection against server-side request forgery:
// - http and https only; ports 80, 443, and 1024 or higher; no credentials
//   in the URL (address.ts).
// - The host name is resolved one time (all A and AAAA records). When any
//   address is in a blocked range, the request is refused.
// - The connection goes to a checked address: the `lookup` option gives the
//   checked list to the socket (no second DNS lookup), and the remote address
//   of the connected socket is checked again. TLS keeps the host name as the
//   server name and the certificate checks stay on.
// - Redirects are followed by hand (GET only, at most 5) with the full check
//   on each hop.
// Robustness: one total time limit, a streamed body read with a cap on the
// decoded bytes, at most 2 requests at one time for each host.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import type { Socket } from "node:net";
import { addressKey, blockedReason, parseAddressPort, parseIp, parseTarget, type Target } from "./address";
import { decodeBody, decodedStream, parseContentEncoding, SUPPORTED_ENCODINGS } from "./decode";
import { HostLimiter } from "./limiter";
import { HttpError, type HttpRequest, type HttpResponse, type SafeHttp, type SafeHttpOptions } from "./types";

export * from "./types";

export const DEFAULT_USER_AGENT = "IndustryIntel/0.1 (internal news reader)";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 3_000_000;
export const MAX_REDIRECTS = 5;
export const MAX_REQUESTS_PER_HOST = 2;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that SafeHttp sets itself; a caller value for them is ignored. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

interface CheckedAddress {
  address: string;
  family: 4 | 6;
}

type Lookup = (hostname: string) => Promise<CheckedAddress[]>;

async function systemLookup(hostname: string): Promise<CheckedAddress[]> {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers
    .filter((answer) => answer.family === 4 || answer.family === 6)
    .map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
}

/** The key of an address with no port; an IPv4-mapped IPv6 address gets the key of its IPv4 address. */
function hostKey(address: string): string | null {
  const parsed = parseIp(address);
  if (!parsed) return null;
  const b = parsed.bytes;
  if (parsed.family === 6 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return addressKey(b.slice(12).join("."), 0);
  }
  return addressKey(address, 0);
}

function isTestRun(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
}

/** Rejects with the abort reason when the signal aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
}

const TLS_CODE = /CERT|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO|ERR_TLS|ERR_SSL|HOSTNAME|ALTNAME/;

/**
 * Maps any error to an HttpError. The message holds only an error code, never
 * a header value or the message of a Node error (it can quote a header value).
 */
function toHttpError(error: unknown, signal: AbortSignal): HttpError {
  if (signal.aborted && signal.reason instanceof HttpError) return signal.reason;
  if (error instanceof HttpError) return error;
  const code = errorCode(error);
  if (code && TLS_CODE.test(code)) {
    return new HttpError("network", `The TLS certificate check of the server failed (${code}).`);
  }
  if (code && /^Z_|ERR__|ERR_ZLIB/.test(code)) {
    return new HttpError("network", `The body of the response does not decompress (${code}).`);
  }
  if (code) return new HttpError("network", `The connection failed (${code}).`);
  return new HttpError("network", "The request failed.");
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function isValidHeader(name: string, value: string): boolean {
  try {
    http.validateHeaderName(name);
    http.validateHeaderValue(name, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the caller's headers can go to the next hop: the same origin, or
 * the same host name with an upgrade from http (port 80) to https (port 443).
 */
function keepsCallerHeaders(from: Target, to: Target): boolean {
  if (from.hostname !== to.hostname) return false;
  if (from.origin === to.origin) return true;
  return !from.https && from.port === 80 && to.https && to.port === 443;
}

export function createSafeHttp(opts: SafeHttpOptions = {}): SafeHttp {
  const testOptions =
    opts.allowPrivateForTests === true ||
    opts.allowAddressesForTests !== undefined ||
    opts.lookupForTests !== undefined ||
    opts.tlsCaForTests !== undefined;
  if (testOptions && !isTestRun()) {
    throw new Error("createSafeHttp: the test options work only in a test run.");
  }

  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const lookup: Lookup = opts.lookupForTests ?? systemLookup;
  const limiter = new HostLimiter(MAX_REQUESTS_PER_HOST);
  const allowAll = opts.allowPrivateForTests === true;
  const allowed = new Set<string>();
  for (const entry of opts.allowAddressesForTests ?? []) {
    const key = parseAddressPort(entry);
    if (!key) throw new Error(`createSafeHttp: "${entry}" is not an address:port pair.`);
    allowed.add(key);
  }

  /** All addresses of the target, checked. Throws blocked_address or network. */
  async function resolveChecked(target: Target, signal: AbortSignal): Promise<CheckedAddress[]> {
    let list: CheckedAddress[];
    if (target.literal) {
      list = [{ address: target.hostname, family: target.literal.family }];
    } else {
      try {
        list = await abortable(lookup(target.hostname), signal);
      } catch (error) {
        if (signal.aborted || error instanceof HttpError) throw error;
        const code = errorCode(error) ?? "no answer";
        throw new HttpError("network", `The host name ${target.hostname} could not be resolved (${code}).`);
      }
      const seen = new Set<string>();
      list = list.filter((entry) => {
        if (seen.has(entry.address)) return false;
        seen.add(entry.address);
        return true;
      });
      if (list.length === 0) throw new HttpError("network", `The host name ${target.hostname} has no address.`);
    }
    for (const entry of list) {
      const reason = blockedReason(entry.address);
      if (reason === null) continue;
      if (allowAll || allowed.has(addressKey(entry.address, target.port) ?? "")) continue;
      throw new HttpError(
        "blocked_address",
        target.literal
          ? `The address ${target.hostname} is in a blocked range (${reason}). The app does not connect to it.`
          : `The host name ${target.hostname} resolves to an address in a blocked range (${reason}). The app does not connect to it.`,
      );
    }
    // IPv4 first: the socket tries the addresses in this order.
    return [...list.filter((entry) => entry.family === 4), ...list.filter((entry) => entry.family === 6)];
  }

  function buildHeaders(req: HttpRequest, target: Target, method: "GET" | "POST", withCaller: boolean, bodyLength: number) {
    const map = new Map<string, [string, string]>();
    const set = (name: string, value: string): void => {
      map.set(name.toLowerCase(), [name, value]);
    };
    set("User-Agent", userAgent);
    set("Accept", "*/*");
    set("Accept-Encoding", SUPPORTED_ENCODINGS);
    if (method === "GET") {
      // Values from a stored response: an invalid value is left out.
      if (req.etag && isValidHeader("If-None-Match", req.etag)) set("If-None-Match", req.etag);
      if (req.lastModified && isValidHeader("If-Modified-Since", req.lastModified)) {
        set("If-Modified-Since", req.lastModified);
      }
    }
    if (withCaller) {
      for (const [name, value] of Object.entries(req.headers ?? {})) {
        if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
        set(name, value);
      }
    }
    set("Host", target.hostHeader);
    if (method === "POST") set("Content-Length", String(bodyLength));
    return Object.fromEntries([...map.values()]);
  }

  /** Sends one request to one checked target. Resolves with the response head. */
  function send(
    target: Target,
    addresses: CheckedAddress[],
    method: "GET" | "POST",
    headers: Record<string, string>,
    body: Buffer | undefined,
    signal: AbortSignal,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const checkedKeys = new Set(addresses.map((entry) => hostKey(entry.address)));
      const isChecked = (remote: string | undefined): boolean => {
        const key = remote ? hostKey(remote) : null;
        return key !== null && checkedKeys.has(key);
      };

      const options: https.RequestOptions = {
        host: target.hostname,
        port: target.port,
        method,
        path: `${target.url.pathname}${target.url.search}`,
        headers,
        agent: false,
      };
      if (!target.literal) {
        // The pin: the socket gets the checked addresses, never a new DNS answer.
        options.lookup = (_hostname, lookupOptions, callback) => {
          const family = lookupOptions.family === 4 || lookupOptions.family === 6 ? lookupOptions.family : 0;
          const matching = family === 0 ? addresses : addresses.filter((entry) => entry.family === family);
          if (lookupOptions.all) {
            const all: LookupAddress[] = matching.map((entry) => ({ address: entry.address, family: entry.family }));
            callback(null, all);
          } else if (matching[0]) {
            callback(null, matching[0].address, matching[0].family);
          } else {
            const error: NodeJS.ErrnoException = new Error("no checked address for this family");
            error.code = "ENOTFOUND";
            callback(error, "", 0);
          }
        };
      }
      if (target.https) {
        options.rejectUnauthorized = true;
        if (!target.literal) options.servername = target.hostname;
        if (opts.tlsCaForTests) options.ca = [opts.tlsCaForTests];
      }

      const request = (target.https ? https : http).request(options);
      const onAbort = (): void => {
        request.destroy(signal.reason instanceof Error ? signal.reason : undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const blocked = (): HttpError =>
        new HttpError("blocked_address", `The connection to ${target.hostname} reached an address that was not checked.`);
      const checkSocket = (socket: Socket): void => {
        if (!isChecked(socket.remoteAddress)) request.destroy(blocked());
      };
      request.on("socket", (socket: Socket) => {
        if (socket.connecting) socket.once("connect", () => checkSocket(socket));
        else checkSocket(socket);
      });
      request.on("response", (response: http.IncomingMessage) => {
        signal.removeEventListener("abort", onAbort);
        if (!isChecked(response.socket?.remoteAddress)) {
          response.destroy();
          reject(blocked());
          return;
        }
        resolve(response);
      });
      request.on("error", (error: Error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      request.end(body);
    });
  }

  /** Reads the body with the cap on the decoded bytes. */
  function readBody(response: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const tooLarge = (): HttpError =>
      new HttpError("too_large", `The response is larger than the limit of ${maxBytes} bytes.`);
    const codings = parseContentEncoding(response.headers["content-encoding"]);
    if (codings.length === 0) {
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        return Promise.reject(tooLarge());
      }
    }
    let stream: ReturnType<typeof decodedStream>;
    try {
      stream = decodedStream(response, codings);
    } catch (error) {
      response.destroy();
      return Promise.reject(error);
    }

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        cleanup();
        stream.destroy();
        response.destroy();
        reject(error);
      };
      const onAbort = (): void => fail(signal.reason);
      if (signal.aborted) {
        fail(signal.reason);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          fail(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => {
        if (settled) return;
        cleanup();
        resolve(Buffer.concat(chunks, size));
      });
      stream.on("error", fail);
      response.on("error", fail);
    });
  }

  async function perform(req: HttpRequest, method: "GET" | "POST", maxBytes: number, signal: AbortSignal) {
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (typeof value !== "string" || !isValidHeader(name, value)) {
        // The kinds of the contract have no "bad request": a bad header is a bad request address.
        throw new HttpError("bad_url", "A request header has a name or a value that is not valid.");
      }
    }
    const body = method === "POST" ? Buffer.from(req.body ?? "", "utf8") : undefined;
    let target = parseTarget(req.url);
    let withCaller = true;
    let redirects = 0;

    for (;;) {
      const addresses = await resolveChecked(target, signal);
      const release = await limiter.acquire(target.hostname, signal);
      try {
        const headers = buildHeaders(req, target, method, withCaller, body?.length ?? 0);
        const response = await send(target, addresses, method, headers, body, signal);
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (method === "GET" && REDIRECT_STATUSES.has(status) && typeof location === "string" && location !== "") {
          response.destroy();
          if (redirects >= MAX_REDIRECTS) {
            throw new HttpError("too_many_redirects", `The address redirected more than ${MAX_REDIRECTS} times.`);
          }
          redirects += 1;
          let next: URL;
          try {
            next = new URL(location, target.url);
          } catch {
            throw new HttpError("bad_url", "A redirect points to an address that is not valid.");
          }
          const nextTarget = parseTarget(next, "redirect address");
          if (!keepsCallerHeaders(target, nextTarget)) withCaller = false;
          target = nextTarget;
          continue;
        }

        const headersOut = flattenHeaders(response.headers);
        const url = target.url.href;
        if (status === 304) {
          response.destroy();
          const etag = headersOut.etag ?? req.etag;
          const lastModified = headersOut["last-modified"] ?? req.lastModified;
          return {
            status,
            ok: false,
            url,
            headers: headersOut,
            text: "",
            notModified: true,
            ...(etag !== undefined ? { etag } : {}),
            ...(lastModified !== undefined ? { lastModified } : {}),
          } satisfies HttpResponse;
        }

        const bytes = await readBody(response, maxBytes, signal);
        const etag = headersOut.etag;
        const lastModified = headersOut["last-modified"];
        return {
          status,
          ok: status >= 200 && status < 300,
          url,
          headers: headersOut,
          text: decodeBody(bytes, headersOut["content-type"]),
          notModified: false,
          ...(etag !== undefined ? { etag } : {}),
          ...(lastModified !== undefined ? { lastModified } : {}),
        } satisfies HttpResponse;
      } finally {
        release();
      }
    }
  }

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "POST") {
        throw new HttpError("bad_url", "The method must be GET or POST.");
      }
      const timeoutMs =
        typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
          ? req.timeoutMs
          : DEFAULT_TIMEOUT_MS;
      const maxBytes =
        typeof req.maxBytes === "number" && Number.isFinite(req.maxBytes) && req.maxBytes >= 0
          ? Math.floor(req.maxBytes)
          : DEFAULT_MAX_BYTES;

      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => {
        controller.abort(new HttpError("timeout", `The request did not finish within ${timeoutMs} ms.`));
      }, timeoutMs);
      const onCallerAbort = (): void => {
        controller.abort(new HttpError("timeout", "The request was stopped."));
      };
      if (req.signal?.aborted) onCallerAbort();
      else req.signal?.addEventListener("abort", onCallerAbort, { once: true });

      try {
        if (signal.aborted) throw signal.reason;
        return await perform(req, method, maxBytes, signal);
      } catch (error) {
        throw toHttpError(error, signal);
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
