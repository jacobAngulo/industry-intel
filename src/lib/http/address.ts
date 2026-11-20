// The address rules of SafeHttp (specification §11.1): which URL is allowed
// and which IP address is public. Pure functions, no network.
import { HttpError } from "./types";

export const ALLOWED_SCHEMES = ["http:", "https:"] as const;

// ---------------------------------------------------------------------------
// IP address parsing (strict: only the canonical text forms)
// ---------------------------------------------------------------------------

/** Dotted decimal with four parts and no leading zero. Returns 4 bytes, or null. */
export function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** An IPv6 address (with `::`, with an IPv4 tail, with or without a zone). Returns 16 bytes, or null. */
export function parseIpv6(text: string): number[] | null {
  let source = text;
  if (source.startsWith("[") && source.endsWith("]")) source = source.slice(1, -1);
  const zone = source.indexOf("%");
  if (zone >= 0) source = source.slice(0, zone);
  if (source.length < 2 || source.length > 45 || !/^[0-9a-fA-F:.]+$/.test(source)) return null;

  const halves = source.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] ?? "";
      if (piece.includes(".")) {
        // An IPv4 tail is allowed only as the last piece of the address.
        if (!last || i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0] ?? "", false);
    const tail = toGroups(halves[1] ?? "", true);
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const all = toGroups(source, true);
    if (!all || all.length !== 8) return null;
    groups = all;
  }

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

export type ParsedIp = { family: 4; bytes: number[] } | { family: 6; bytes: number[] };

/** Parses an IPv4 or an IPv6 literal. Returns null when the text is not an IP address. */
export function parseIp(text: string): ParsedIp | null {
  const v4 = parseIpv4(text);
  if (v4) return { family: 4, bytes: v4 };
  if (text.includes(":")) {
    const v6 = parseIpv6(text);
    if (v6) return { family: 6, bytes: v6 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Blocked ranges
// ---------------------------------------------------------------------------

type Range = { bytes: number[]; bits: number; name: string };

function range(cidr: string, name: string): Range {
  const [address = "", bits = ""] = cidr.split("/");
  const parsed = parseIp(address);
  if (!parsed) throw new Error(`Bad range ${cidr}`);
  return { bytes: parsed.bytes, bits: Number(bits), name };
}

function inRange(bytes: readonly number[], candidate: Range): boolean {
  if (bytes.length !== candidate.bytes.length) return false;
  let bits = candidate.bits;
  for (let i = 0; i < bytes.length && bits > 0; i += 1) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((candidate.bytes[i] ?? 0) & mask)) return false;
    bits -= 8;
  }
  return true;
}

/** The blocked IPv4 ranges (specification §11.1 and the task list of the http phase). */
export const BLOCKED_IPV4_RANGES: readonly Range[] = [
  range("0.0.0.0/8", "this network"),
  range("10.0.0.0/8", "private"),
  range("100.64.0.0/10", "carrier-grade NAT"),
  range("127.0.0.0/8", "loopback"),
  range("169.254.0.0/16", "link-local (cloud metadata)"),
  range("172.16.0.0/12", "private"),
  range("192.0.0.0/24", "protocol assignments"),
  range("192.0.2.0/24", "documentation"),
  range("192.168.0.0/16", "private"),
  range("198.18.0.0/15", "benchmark"),
  range("198.51.100.0/24", "documentation"),
  range("203.0.113.0/24", "documentation"),
  range("224.0.0.0/4", "multicast"),
  range("240.0.0.0/4", "reserved"),
];

/** IPv6 ranges that are blocked as a whole. */
export const BLOCKED_IPV6_RANGES: readonly Range[] = [
  // `::`, `::1`, and the old IPv4-compatible form `::a.b.c.d`.
  range("::/96", "unspecified, loopback, or IPv4-compatible"),
  range("64:ff9b:1::/48", "local NAT64"),
  range("2001::/32", "Teredo"),
  range("2001:db8::/32", "documentation"),
  range("fc00::/7", "unique local"),
  range("fe80::/10", "link-local"),
  range("fec0::/10", "site-local"),
  range("ff00::/8", "multicast"),
];

/** IPv6 ranges that carry an IPv4 address: the IPv4 rules apply to the carried address. */
const EMBEDDED_IPV4_RANGES: ReadonlyArray<Range & { offset: number }> = [
  { ...range("::ffff:0:0/96", "IPv4-mapped"), offset: 12 },
  { ...range("64:ff9b::/96", "NAT64"), offset: 12 },
  { ...range("2002::/16", "6to4"), offset: 2 },
];

function blockedIpv4(bytes: readonly number[]): string | null {
  return BLOCKED_IPV4_RANGES.find((candidate) => inRange(bytes, candidate))?.name ?? null;
}

function blockedIpv6(bytes: readonly number[]): string | null {
  const whole = BLOCKED_IPV6_RANGES.find((candidate) => inRange(bytes, candidate));
  if (whole) return whole.name;
  for (const embedded of EMBEDDED_IPV4_RANGES) {
    if (!inRange(bytes, embedded)) continue;
    const inner = blockedIpv4(bytes.slice(embedded.offset, embedded.offset + 4));
    if (inner) return `${embedded.name} form of a ${inner} address`;
  }
  return null;
}

/**
 * The reason why the app does not connect to this address, or null when the
 * address is public. Text that is not an IP address is blocked (fail closed).
 */
export function blockedReason(address: string): string | null {
  const parsed = parseIp(address);
  if (!parsed) return "not an IP address";
  return parsed.family === 4 ? blockedIpv4(parsed.bytes) : blockedIpv6(parsed.bytes);
}

/** True when the app must not connect to this address. */
export function isBlockedAddress(address: string): boolean {
  return blockedReason(address) !== null;
}

/** One canonical text for an address and a port (the key of the test allowance). */
export function addressKey(address: string, port: number): string | null {
  const parsed = parseIp(address);
  if (!parsed) return null;
  return `${parsed.family}:${parsed.bytes.join(".")}:${port}`;
}

/** Parses "127.0.0.1:4420" or "[::1]:4421" into the key of `addressKey`. */
export function parseAddressPort(entry: string): string | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):([0-9]{1,5})$/.exec(entry.trim());
  if (!match) return null;
  return addressKey(match[1] ?? match[2] ?? "", Number(match[3]));
}

// ---------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------

/** Ports 80, 443, and 1024 or higher. */
export function isAllowedPort(port: number): boolean {
  return Number.isInteger(port) && (port === 80 || port === 443 || (port >= 1024 && port <= 65535));
}

export interface Target {
  url: URL;
  https: boolean;
  /** The host with no brackets: a name, an IPv4 literal, or an IPv6 literal. */
  hostname: string;
  port: number;
  /** The value of the Host header. */
  hostHeader: string;
  /** Scheme, host, and port: caller headers stay inside one origin. */
  origin: string;
  /** Set when the host is an IP literal. */
  literal: ParsedIp | null;
}

/**
 * Checks a URL against the scheme, credential, and port rules. The WHATWG URL
 * class normalizes the numeric IPv4 forms (decimal, hex, octal, short), so a
 * host such as `2130706433` or `0x7f.1` arrives here as `127.0.0.1`.
 * Throws HttpError kind `bad_url`.
 */
export function parseTarget(input: string | URL, what = "address"): Target {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input.trim() : input.href);
  } catch {
    throw new HttpError("bad_url", `The ${what} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError("bad_url", `The ${what} must start with http:// or https://.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new HttpError("bad_url", `The ${what} must not contain a user name or a password.`);
  }
  const https = url.protocol === "https:";
  const port = url.port === "" ? (https ? 443 : 80) : Number(url.port);
  if (!isAllowedPort(port)) {
    throw new HttpError("bad_url", `The ${what} uses port ${port}. The app connects only to the ports 80, 443, and 1024 or higher.`);
  }
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const hostname = bracketed ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === "") throw new HttpError("bad_url", `The ${what} has no host.`);

  const literal = parseIp(hostname);
  if (bracketed && literal?.family !== 6) throw new HttpError("bad_url", `The ${what} has a host that is not valid.`);
  // A name must not look like an address that this module cannot parse.
  if (!literal && (hostname.includes(":") || /^[0-9.]+$/.test(hostname))) {
    throw new HttpError("bad_url", `The ${what} has a host that is not valid.`);
  }

  url.hash = "";
  return { url, https, hostname, port, hostHeader: url.host, origin: url.origin, literal };
}
