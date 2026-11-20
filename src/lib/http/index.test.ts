// SafeHttp against real local servers on 127.0.0.1 and ::1. No outside network.
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "@/test/helpers";
import { createSafeHttp, DEFAULT_USER_AGENT, HttpError, type HttpErrorKind, type SafeHttpOptions } from "./index";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
  port: number;
  host: string;
  /** The URL with the IP literal. */
  url: (path?: string) => string;
  /** Requests that reached the handler. */
  hits: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string; servername?: string }>;
  /** "127.0.0.1:port" or "[::1]:port". */
  pair: string;
}

const servers: Array<http.Server | https.Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.unstubAllEnvs();
});

async function startServer(handler: Handler, host = "127.0.0.1", tls?: { key: string; cert: string }): Promise<TestServer> {
  const hits: TestServer["hits"] = [];
  const wrapped: Handler = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const socket = req.socket as { servername?: string | false };
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        ...(typeof socket.servername === "string" ? { servername: socket.servername } : {}),
      });
      handler(req, res);
    });
  };
  const server = tls ? https.createServer(tls, wrapped) : http.createServer(wrapped);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  const scheme = tls ? "https" : "http";
  return { port, host, hits, url: (path = "/") => `${scheme}://${hostPart}:${port}${path}`, pair: `${hostPart}:${port}` };
}

async function errorKind(promise: Promise<unknown>): Promise<HttpErrorKind | "resolved" | "other"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof HttpError ? error.kind : "other";
  }
}

async function caught(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected an HttpError");
}

/** A lookup that maps test names to loopback and counts the calls. */
function fakeDns(map: Record<string, Array<{ address: string; family: 4 | 6 }>>) {
  const calls: string[] = [];
  const lookup: NonNullable<SafeHttpOptions["lookupForTests"]> = async (hostname) => {
    calls.push(hostname);
    const answer = map[hostname];
    if (!answer) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return answer;
  };
  return { lookup, calls };
}

const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello");
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("address guard", () => {
  it("refuses a local server with the guard on and reaches it with the test allowance", async () => {
    const server = await startServer(ok);
    expect(await errorKind(createSafeHttp().request({ url: server.url() }))).toBe("blocked_address");
    expect(server.hits).toHaveLength(0);

    const all = await createSafeHttp({ allowPrivateForTests: true }).request({ url: server.url() });
    expect(all.status).toBe(200);
    expect(all.text).toBe("hello");

    const pair = await createSafeHttp({ allowAddressesForTests: [server.pair] }).request({ url: server.url() });
    expect(pair.ok).toBe(true);

    const otherPair = createSafeHttp({ allowAddressesForTests: ["127.0.0.1:1"] });
    expect(await errorKind(otherPair.request({ url: server.url() }))).toBe("blocked_address");
  });

  it("refuses ::1 with the guard on and reaches it with the test allowance", async () => {
    const server = await startServer(ok, "::1");
    expect(await errorKind(createSafeHttp().request({ url: server.url() }))).toBe("blocked_address");
    const response = await createSafeHttp({ allowAddressesForTests: [server.pair] }).request({ url: server.url() });
    expect(response.text).toBe("hello");
    expect(server.hits[0]?.headers.host).toBe(`[::1]:${server.port}`);
  });

  it("refuses the numeric forms of 127.0.0.1 and the IPv4-mapped form", async () => {
    const server = await startServer(ok);
    const guarded = createSafeHttp();
    const allowed = createSafeHttp({ allowAddressesForTests: [server.pair] });
    for (const host of ["2130706433", "0x7f000001", "017700000001", "127.1"]) {
      const url = `http://${host}:${server.port}/`;
      expect(await errorKind(guarded.request({ url }))).toBe("blocked_address");
      // The same URL reaches 127.0.0.1 when the pair is allowed: the URL class normalized it.
      expect((await allowed.request({ url })).status).toBe(200);
    }
    expect(await errorKind(guarded.request({ url: `http://[::ffff:127.0.0.1]:${server.port}/` }))).toBe("blocked_address");
    expect(server.hits).toHaveLength(4);
  });

  it("refuses localhost through the system resolver", async () => {
    const server = await startServer(ok);
    expect(await errorKind(createSafeHttp().request({ url: `http://localhost:${server.port}/` }))).toBe("blocked_address");
    expect(server.hits).toHaveLength(0);
  });

  it("refuses a name when any of its addresses is blocked", async () => {
    const dns = fakeDns({ "mixed.test": [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.7", family: 4 }] });
    const error = await caught(createSafeHttp({ lookupForTests: dns.lookup }).request({ url: "http://mixed.test/" }));
    expect(error.kind).toBe("blocked_address");
    expect(error.message).toMatch(/mixed\.test/);
  });

  it("refuses blocked names of IPv6 forms", async () => {
    const dns = fakeDns({
      "v6.test": [{ address: "::ffff:169.254.169.254", family: 6 }],
      "nat64.test": [{ address: "64:ff9b::7f00:1", family: 6 }],
    });
    const client = createSafeHttp({ lookupForTests: dns.lookup });
    expect(await errorKind(client.request({ url: "http://v6.test/" }))).toBe("blocked_address");
    expect(await errorKind(client.request({ url: "http://nat64.test/" }))).toBe("blocked_address");
  });

  it("connects to the checked address with the right Host header (one lookup, no second DNS)", async () => {
    const server = await startServer(ok);
    // "pinned.test" does not exist in real DNS: the request works only through the pin.
    const dns = fakeDns({ "pinned.test": [{ address: "127.0.0.1", family: 4 }] });
    const client = createSafeHttp({ lookupForTests: dns.lookup, allowAddressesForTests: [server.pair] });
    const response = await client.request({ url: `http://pinned.test:${server.port}/x?y=1` });
    expect(response.status).toBe(200);
    expect(response.url).toBe(`http://pinned.test:${server.port}/x?y=1`);
    expect(dns.calls).toEqual(["pinned.test"]);
    expect(server.hits[0]?.headers.host).toBe(`pinned.test:${server.port}`);
    expect(server.hits[0]?.url).toBe("/x?y=1");
  });

  it("refuses bad URLs, other schemes, credentials, and low ports", async () => {
    const client = createSafeHttp({ allowPrivateForTests: true });
    for (const url of ["not a url", "ftp://example.com/", "file:///etc/hosts", "http://u:p@example.com/", "http://example.com:22/"]) {
      expect(await errorKind(client.request({ url }))).toBe("bad_url");
    }
  });

  it("allows the test options only in a test run", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", undefined);
    expect(() => createSafeHttp({ allowPrivateForTests: true })).toThrow(/test run/);
    expect(() => createSafeHttp()).not.toThrow();
  });
});

describe("redirects", () => {
  it("refuses a redirect to a blocked address on the hop", async () => {
    const blocked = await startServer(ok);
    const first = await startServer((_req, res) => {
      res.writeHead(302, { location: blocked.url("/secret") });
      res.end();
    });
    const client = createSafeHttp({ allowAddressesForTests: [first.pair] });
    expect(await errorKind(client.request({ url: first.url() }))).toBe("blocked_address");
    expect(first.hits).toHaveLength(1);
    expect(blocked.hits).toHaveLength(0);
  });

  it("refuses a redirect to the metadata address and to another scheme", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(301, { location: req.url === "/ftp" ? "ftp://example.com/" : "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    expect(await errorKind(client.request({ url: server.url("/meta") }))).toBe("blocked_address");
    expect(await errorKind(client.request({ url: server.url("/ftp") }))).toBe("bad_url");
  });

  const chain: Handler = (req, res) => {
    const n = Number(/^\/r\/(\d+)$/.exec(req.url ?? "")?.[1] ?? "0");
    if (n === 0) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("end of chain");
      return;
    }
    res.writeHead(n % 2 === 0 ? 307 : 301, { location: `/r/${n - 1}` });
    res.end("moved");
  };

  it("follows 5 redirects and gives the final URL", async () => {
    const server = await startServer(chain);
    const response = await createSafeHttp({ allowAddressesForTests: [server.pair] }).request({ url: server.url("/r/5") });
    expect(response.status).toBe(200);
    expect(response.text).toBe("end of chain");
    expect(response.url).toBe(server.url("/r/0"));
    expect(server.hits).toHaveLength(6);
  });

  it("stops a chain of 6 redirects with too_many_redirects", async () => {
    const server = await startServer(chain);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    expect(await errorKind(client.request({ url: server.url("/r/6") }))).toBe("too_many_redirects");
    expect(server.hits).toHaveLength(6);
  });

  it("gives a redirect to a POST back as it is", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(303, { location: "/other" });
      res.end("see other");
    });
    const response = await createSafeHttp({ allowAddressesForTests: [server.pair] }).request({
      url: server.url("/form"),
      method: "POST",
      body: "a=1",
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/other");
    expect(response.text).toBe("see other");
    expect(server.hits).toHaveLength(1);
  });

  it("gives a redirect with no Location back as it is", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(302);
      res.end();
    });
    const response = await createSafeHttp({ allowAddressesForTests: [server.pair] }).request({ url: server.url() });
    expect(response.status).toBe(302);
  });
});

describe("header rules", () => {
  it("keeps the caller's headers inside one origin and drops them for another host", async () => {
    const b = await startServer((req, res) => {
      if (req.url === "/back") {
        res.writeHead(302, { location: `http://a.test:${aPort}/final` });
        res.end();
        return;
      }
      ok(req, res);
    });
    let aPort = 0;
    const a = await startServer((req, res) => {
      if (req.url === "/to-b") res.writeHead(302, { location: `http://b.test:${b.port}/landed` });
      else if (req.url === "/same") res.writeHead(302, { location: "/landed" });
      else if (req.url === "/round") res.writeHead(302, { location: `http://b.test:${b.port}/back` });
      else {
        res.writeHead(200);
        res.end("a");
        return;
      }
      res.end();
    });
    aPort = a.port;
    const dns = fakeDns({ "a.test": [{ address: "127.0.0.1", family: 4 }], "b.test": [{ address: "127.0.0.1", family: 4 }] });
    const client = createSafeHttp({ lookupForTests: dns.lookup, allowAddressesForTests: [a.pair, b.pair] });
    const headers = { Authorization: "Bearer sekret-token", "X-Custom": "yes" };

    await client.request({ url: `http://a.test:${a.port}/same`, headers });
    expect(a.hits.map((hit) => hit.headers.authorization)).toEqual(["Bearer sekret-token", "Bearer sekret-token"]);

    await client.request({ url: `http://a.test:${a.port}/to-b`, headers });
    const landed = b.hits.at(-1);
    expect(landed?.url).toBe("/landed");
    expect(landed?.headers.authorization).toBeUndefined();
    expect(landed?.headers["x-custom"]).toBeUndefined();
    expect(landed?.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(landed?.headers.host).toBe(`b.test:${b.port}`);

    // A -> B -> A: the headers stay dropped after they left the first host.
    await client.request({ url: `http://a.test:${a.port}/round`, headers });
    const final = a.hits.at(-1);
    expect(final?.url).toBe("/final");
    expect(final?.headers.authorization).toBeUndefined();
  });

  it("sends the default headers and lets the caller's headers win", async () => {
    const server = await startServer(ok);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    await client.request({ url: server.url() });
    expect(server.hits[0]?.headers["user-agent"]).toBe("IndustryIntel/0.1 (internal news reader)");
    expect(server.hits[0]?.headers.accept).toBe("*/*");
    expect(server.hits[0]?.headers["accept-encoding"]).toBe("gzip, deflate, br");

    await client.request({
      url: server.url(),
      headers: { "user-agent": "Custom/1", Accept: "application/json", Host: "evil.example" },
    });
    expect(server.hits[1]?.headers["user-agent"]).toBe("Custom/1");
    expect(server.hits[1]?.headers.accept).toBe("application/json");
    expect(server.hits[1]?.headers.host).toBe(server.pair);

    const custom = createSafeHttp({ allowAddressesForTests: [server.pair], userAgent: "Other/2" });
    await custom.request({ url: server.url() });
    expect(server.hits[2]?.headers["user-agent"]).toBe("Other/2");
  });

  it("refuses a header value that is not valid, with no value in the message", async () => {
    const server = await startServer(ok);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const error = await caught(client.request({ url: server.url(), headers: { Authorization: "Bearer sekret\r\nX: y" } }));
    expect(error.kind).toBe("bad_url");
    expect(error.message).not.toMatch(/sekret/);
    expect(server.hits).toHaveLength(0);
  });
});

describe("body", () => {
  it("sends a POST with a body", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const body = JSON.stringify({ text: "héllo wörld ✓" });
    const response = await client.request({
      url: server.url("/api"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      etag: '"ignored-for-post"',
    });
    expect(response.status).toBe(201);
    expect(JSON.parse(response.text)).toEqual({ ok: true });
    const hit = server.hits[0];
    expect(hit?.method).toBe("POST");
    expect(hit?.body).toBe(body);
    expect(hit?.headers["content-type"]).toBe("application/json");
    expect(hit?.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(hit?.headers["if-none-match"]).toBeUndefined();
  });

  it("caps a plain body (with and without Content-Length)", async () => {
    const server = await startServer((req, res) => {
      const body = "x".repeat(2000);
      if (req.url === "/declared") {
        res.writeHead(200, { "content-length": "2000" });
        res.end(body);
      } else if (req.url === "/exact") {
        res.writeHead(200);
        res.end("y".repeat(1000));
      } else {
        res.writeHead(200);
        res.write(body.slice(0, 900));
        res.end(body.slice(900));
      }
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    expect(await errorKind(client.request({ url: server.url("/declared"), maxBytes: 1000 }))).toBe("too_large");
    expect(await errorKind(client.request({ url: server.url("/chunked"), maxBytes: 1000 }))).toBe("too_large");
    expect((await client.request({ url: server.url("/exact"), maxBytes: 1000 })).text).toHaveLength(1000);
  });

  it("decodes gzip, deflate (zlib and raw), and br", async () => {
    const text = "Café news ".repeat(200);
    const encoded: Record<string, [string, Buffer]> = {
      "/gzip": ["gzip", zlib.gzipSync(text)],
      "/deflate": ["deflate", zlib.deflateSync(text)],
      "/raw": ["deflate", zlib.deflateRawSync(text)],
      "/br": ["br", zlib.brotliCompressSync(text)],
      "/double": ["deflate, gzip", zlib.gzipSync(zlib.deflateSync(text))],
    };
    const server = await startServer((req, res) => {
      const [coding, body] = encoded[req.url ?? ""] ?? ["identity", Buffer.from(text)];
      res.writeHead(200, { "content-encoding": coding, "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    for (const path of Object.keys(encoded)) {
      expect((await client.request({ url: server.url(path) })).text).toBe(text);
    }
  });

  it("stops a gzip bomb at the cap with too_large", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-length": String(bomb.length) });
      res.end(bomb);
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const before = process.memoryUsage().rss;
    const error = await caught(client.request({ url: server.url(), maxBytes: 1_000_000 }));
    expect(error.kind).toBe("too_large");
    expect(process.memoryUsage().rss - before).toBeLessThan(48 * 1024 * 1024);
  });

  it("refuses an unknown content coding", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "zstd" });
      res.end("abc");
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    expect(await errorKind(client.request({ url: server.url() }))).toBe("network");
  });

  it("decodes the charset of the header, of the XML declaration, else UTF-8", async () => {
    const latin1 = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in ISO-8859-1
    const bodies: Record<string, [string | undefined, Buffer]> = {
      "/header": ["text/html; charset=ISO-8859-1", latin1],
      "/quoted": ['text/plain; charset="windows-1252"', Buffer.from([0x80])],
      "/xml": ["application/rss+xml", Buffer.concat([Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><t>'), latin1, Buffer.from("</t>")])],
      "/meta": ["text/html", Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head>'), latin1])],
      "/sjis": ["text/plain; charset=Shift_JIS", Buffer.from([0x93, 0xfa, 0x96, 0x7b])],
      "/utf8": [undefined, Buffer.from("Café ✓", "utf8")],
      "/unknown": ["text/plain; charset=x-bogus", Buffer.from("Café", "utf8")],
      "/bom": ["text/plain; charset=iso-8859-1", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Café", "utf8")])],
    };
    const server = await startServer((req, res) => {
      const [type, body] = bodies[req.url ?? ""] ?? [undefined, Buffer.alloc(0)];
      res.writeHead(200, type ? { "content-type": type } : {});
      res.end(body);
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const text = async (path: string) => (await client.request({ url: server.url(path) })).text;
    expect(await text("/header")).toBe("Café");
    expect(await text("/quoted")).toBe("€");
    expect(await text("/xml")).toBe('<?xml version="1.0" encoding="iso-8859-1"?><t>Café</t>');
    expect(await text("/meta")).toContain("Café");
    expect(await text("/sjis")).toBe("日本");
    expect(await text("/utf8")).toBe("Café ✓");
    expect(await text("/unknown")).toBe("Café");
    expect(await text("/bom")).toBe("Café");
  });

  it("gives status codes back without an error, with lower-case headers", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("X-Thing", ["a", "b"]);
      res.writeHead(503, { "Retry-After": "30" });
      res.end("busy");
    });
    const response = await createSafeHttp({ allowAddressesForTests: [server.pair] }).request({ url: server.url() });
    expect(response.status).toBe(503);
    expect(response.ok).toBe(false);
    expect(response.text).toBe("busy");
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.headers["x-thing"]).toBe("a, b");
  });

  it("gives network for a refused connection", async () => {
    const server = await startServer(ok);
    const port = server.port;
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    const client = createSafeHttp({ allowAddressesForTests: [`127.0.0.1:${port}`] });
    const error = await caught(client.request({ url: `http://127.0.0.1:${port}/` }));
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/ECONNREFUSED/);
  });
});

describe("conditional GET", () => {
  it("sends the validators and reads a 304", async () => {
    const server = await startServer((req, res) => {
      const etag = '"v2"';
      const lastModified = "Wed, 18 Nov 2026 10:00:00 GMT";
      if (req.headers["if-none-match"] === etag || req.headers["if-modified-since"] === lastModified) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { etag, "last-modified": lastModified, "content-type": "application/xml" });
      res.end("<rss/>");
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const first = await client.request({ url: server.url() });
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"v2"');
    expect(first.lastModified).toBe("Wed, 18 Nov 2026 10:00:00 GMT");
    expect(first.text).toBe("<rss/>");

    const byEtag = await client.request({ url: server.url(), etag: first.etag });
    expect(server.hits[1]?.headers["if-none-match"]).toBe('"v2"');
    expect(byEtag.status).toBe(304);
    expect(byEtag.notModified).toBe(true);
    expect(byEtag.text).toBe("");
    expect(byEtag.etag).toBe('"v2"');

    const byDate = await client.request({ url: server.url(), lastModified: first.lastModified });
    expect(server.hits[2]?.headers["if-modified-since"]).toBe("Wed, 18 Nov 2026 10:00:00 GMT");
    expect(byDate.notModified).toBe(true);
    // The 304 has no Last-Modified: the request value stays valid.
    expect(byDate.lastModified).toBe("Wed, 18 Nov 2026 10:00:00 GMT");
  });
});

describe("time limit", () => {
  it("stops a slow header", async () => {
    const server = await startServer(() => {
      // Never answers.
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const started = Date.now();
    expect(await errorKind(client.request({ url: server.url(), timeoutMs: 300 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops a slow body", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part one");
      // The rest never comes.
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const started = Date.now();
    expect(await errorKind(client.request({ url: server.url(), timeoutMs: 300 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("counts the redirects inside the one time limit", async () => {
    const server = await startServer((req, res) => {
      const n = Number(/^\/s\/(\d+)$/.exec(req.url ?? "")?.[1] ?? "0");
      setTimeout(() => {
        res.writeHead(302, { location: `/s/${n + 1}` });
        res.end();
      }, 120);
    });
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    // Each hop takes 120 ms; 5 hops would take 600 ms.
    expect(await errorKind(client.request({ url: server.url("/s/0"), timeoutMs: 350 }))).toBe("timeout");
  });

  it("stops when the caller's signal aborts", async () => {
    const server = await startServer(() => undefined);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await errorKind(client.request({ url: server.url(), signal: controller.signal }))).toBe("timeout");

    const aborted = new AbortController();
    aborted.abort();
    expect(await errorKind(client.request({ url: server.url(), signal: aborted.signal }))).toBe("timeout");
  });
});

describe("per-host limit", () => {
  function counting(holdMs: number) {
    const state = { now: 0, max: 0 };
    const handler: Handler = (_req, res) => {
      state.now += 1;
      state.max = Math.max(state.max, state.now);
      setTimeout(() => {
        state.now -= 1;
        res.writeHead(200);
        res.end("done");
      }, holdMs);
    };
    return { state, handler };
  }

  it("runs at most 2 requests at one time for one host", async () => {
    const { state, handler } = counting(80);
    const server = await startServer(handler);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const results = await Promise.all(Array.from({ length: 6 }, () => client.request({ url: server.url() })));
    expect(results.every((response) => response.text === "done")).toBe(true);
    expect(state.max).toBe(2);
  });

  it("limits each host on its own", async () => {
    const { state, handler } = counting(120);
    const server = await startServer(handler);
    const dns = fakeDns({ "a.test": [{ address: "127.0.0.1", family: 4 }], "b.test": [{ address: "127.0.0.1", family: 4 }] });
    const client = createSafeHttp({ lookupForTests: dns.lookup, allowAddressesForTests: [server.pair] });
    await Promise.all(
      ["a.test", "a.test", "a.test", "b.test", "b.test", "b.test"].map((host) =>
        client.request({ url: `http://${host}:${server.port}/` }),
      ),
    );
    expect(state.max).toBe(4);
  });

  it("counts the wait in the queue inside the time limit", async () => {
    const { handler } = counting(300);
    const server = await startServer(handler);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const kinds = await Promise.all(
      [0, 1, 2].map(async (i) => {
        if (i === 2) await sleep(20);
        return errorKind(client.request({ url: server.url(), timeoutMs: 450 }));
      }),
    );
    expect(kinds).toEqual(["resolved", "resolved", "timeout"]);
    // The slot of the stopped request is free again.
    await sleep(350);
    expect((await client.request({ url: server.url() })).status).toBe(200);
  });
});

describe("TLS", () => {
  const tls = {
    key: loadFixture("test-tls.synthetic.key.pem"),
    cert: loadFixture("test-tls.synthetic.cert.pem"),
  };

  it("pins the address and keeps the host name for SNI and the certificate check", async () => {
    const server = await startServer(ok, "127.0.0.1", tls);
    const dns = fakeDns({
      "pinned.test": [{ address: "127.0.0.1", family: 4 }],
      "other.test": [{ address: "127.0.0.1", family: 4 }],
    });
    const trusted = createSafeHttp({ lookupForTests: dns.lookup, allowAddressesForTests: [server.pair], tlsCaForTests: tls.cert });
    const response = await trusted.request({ url: `https://pinned.test:${server.port}/` });
    expect(response.text).toBe("hello");
    expect(server.hits[0]?.servername).toBe("pinned.test");
    expect(server.hits[0]?.headers.host).toBe(`pinned.test:${server.port}`);

    // The certificate is not valid for this name.
    const wrongName = await caught(trusted.request({ url: `https://other.test:${server.port}/` }));
    expect(wrongName.kind).toBe("network");
    expect(wrongName.message).toMatch(/certificate/);

    // An IP literal is checked against the IP address of the certificate.
    expect((await trusted.request({ url: server.url() })).status).toBe(200);
  });

  it("keeps the certificate checks on", async () => {
    const server = await startServer(ok, "127.0.0.1", tls);
    const client = createSafeHttp({ allowAddressesForTests: [server.pair] });
    const error = await caught(client.request({ url: server.url() }));
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/certificate/);
    expect(server.hits).toHaveLength(0);
  });
});
