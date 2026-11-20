// The HTTP contract of specification §11.1. Every outbound HTTP request of
// the app goes through a SafeHttp.

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Default 15 000. */
  timeoutMs?: number;
  /** Default 3 000 000. */
  maxBytes?: number;
  /** Conditional GET. */
  etag?: string;
  lastModified?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  /** The final URL after redirects. */
  url: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  /** The decoded body ('' for 304). */
  text: string;
  notModified: boolean;
  etag?: string;
  lastModified?: string;
}

export interface SafeHttp {
  /**
   * Does not throw for HTTP status codes (the caller reads `status`).
   * Throws HttpError for the kinds below.
   */
  request(req: HttpRequest): Promise<HttpResponse>;
}

export type HttpErrorKind =
  | "bad_url"
  | "blocked_address"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "network";

export class HttpError extends Error {
  kind: HttpErrorKind;

  constructor(kind: HttpErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HttpError";
    this.kind = kind;
  }
}

export interface SafeHttpOptions {
  /**
   * Tests only: connect to blocked addresses (loopback, private, ...).
   * createSafeHttp throws when a test option is set outside vitest
   * (NODE_ENV "test" or VITEST).
   */
  allowPrivateForTests?: boolean;
  userAgent?: string;
  /**
   * Tests only: a finer allowance than `allowPrivateForTests`. Only these
   * address:port pairs ("127.0.0.1:4420", "[::1]:4421") are exempt from the
   * address rules; every other blocked address stays blocked.
   */
  allowAddressesForTests?: string[];
  /**
   * Tests only: replaces the DNS resolution (all A and AAAA records of a
   * name). The result goes through the same address rules.
   */
  lookupForTests?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** Tests only: an extra trusted CA certificate (PEM) for https. */
  tlsCaForTests?: string;
}
