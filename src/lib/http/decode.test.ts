import { Readable } from "node:stream";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  charsetFromContentType,
  charsetFromDocument,
  decodeBody,
  decodedStream,
  decodeWindows1252,
  parseContentEncoding,
} from "./decode";
import { HostLimiter } from "./limiter";
import { HttpError } from "./types";

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("content codings", () => {
  it("parses the Content-Encoding header", () => {
    expect(parseContentEncoding(undefined)).toEqual([]);
    expect(parseContentEncoding("identity")).toEqual([]);
    expect(parseContentEncoding(" GZIP ")).toEqual(["gzip"]);
    expect(parseContentEncoding("deflate, br")).toEqual(["deflate", "br"]);
  });

  it("decodes each coding as a stream", async () => {
    const text = "stream ".repeat(1000);
    expect(await collect(decodedStream(Readable.from([zlib.gzipSync(text)]), ["gzip"]))).toBe(text);
    expect(await collect(decodedStream(Readable.from([zlib.deflateSync(text)]), ["deflate"]))).toBe(text);
    expect(await collect(decodedStream(Readable.from([zlib.deflateRawSync(text)]), ["deflate"]))).toBe(text);
    expect(await collect(decodedStream(Readable.from([zlib.brotliCompressSync(text)]), ["br"]))).toBe(text);
    // The zlib header split over two chunks.
    const split = zlib.deflateSync(text);
    expect(await collect(decodedStream(Readable.from([split.subarray(0, 1), split.subarray(1)]), ["deflate"]))).toBe(text);
  });

  it("gives the bytes of a truncated gzip stream", async () => {
    const text = "truncated ".repeat(500);
    const whole = zlib.gzipSync(text);
    const out = await collect(decodedStream(Readable.from([whole.subarray(0, whole.length - 8)]), ["gzip"]));
    expect(out).toBe(text);
  });

  it("refuses an unknown coding", () => {
    expect(() => decodedStream(Readable.from([Buffer.from("x")]), ["zstd"])).toThrow(HttpError);
  });
});

describe("charset", () => {
  it("reads the charset parameter", () => {
    expect(charsetFromContentType("text/html; charset=UTF-8")).toBe("utf-8");
    expect(charsetFromContentType('text/html; charset="iso-8859-1"')).toBe("windows-1252");
    expect(charsetFromContentType("text/html")).toBeNull();
    expect(charsetFromContentType("text/html; charset=nonsense")).toBeNull();
  });

  it("reads the XML declaration and the HTML meta charset", () => {
    expect(charsetFromDocument(Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><a/>'))).toBe("shift_jis");
    expect(charsetFromDocument(Buffer.from("<?xml version='1.0' encoding='windows-1251'?>"))).toBe("windows-1251");
    expect(charsetFromDocument(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=koi8-r">'))).toBe("koi8-r");
    expect(charsetFromDocument(Buffer.from('<?xml version="1.0" encoding="UTF-16"?>'))).toBe("utf-8");
    expect(charsetFromDocument(Buffer.from("<html>no charset</html>"))).toBeNull();
  });

  it("decodes windows-1252 with the right table", () => {
    expect(decodeWindows1252(Uint8Array.from([0x80, 0x92, 0x93, 0x94, 0x9f, 0xe9, 0x41]))).toBe("€’“”Ÿé" + "A");
    expect(decodeBody(Uint8Array.from([0x93, 0x68, 0x69, 0x94]), "text/plain; charset=windows-1252")).toBe("“hi”");
  });

  it("decodes UTF-16 with a byte order mark", () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hé", "utf16le")]);
    expect(decodeBody(body, undefined)).toBe("Hé");
  });

  it("uses UTF-8 by default and replaces bad bytes", () => {
    expect(decodeBody(Buffer.from("naïve", "utf8"), undefined)).toBe("naïve");
    expect(decodeBody(Uint8Array.from([0x61, 0xff, 0x62]), "text/plain")).toBe("a�b");
    expect(decodeBody(new Uint8Array(0), "text/plain")).toBe("");
  });
});

describe("HostLimiter", () => {
  it("gives slots in order and frees them", async () => {
    const limiter = new HostLimiter(2);
    const signal = new AbortController().signal;
    const first = await limiter.acquire("a", signal);
    const second = await limiter.acquire("a", signal);
    const order: number[] = [];
    const third = limiter.acquire("a", signal).then((release) => {
      order.push(3);
      return release;
    });
    const fourth = limiter.acquire("a", signal).then((release) => {
      order.push(4);
      return release;
    });
    expect(limiter.active("a")).toBe(2);
    expect(limiter.waiting("a")).toBe(2);
    // Another host is not limited by "a".
    (await limiter.acquire("b", signal))();

    first();
    first(); // A second call does nothing.
    (await third)();
    second();
    (await fourth)();
    expect(order).toEqual([3, 4]);
    expect(limiter.active("a")).toBe(0);
    expect(limiter.waiting("a")).toBe(0);
  });

  it("removes a waiter when its signal aborts", async () => {
    const limiter = new HostLimiter(1);
    const release = await limiter.acquire("a", new AbortController().signal);
    const controller = new AbortController();
    const waiting = limiter.acquire("a", controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(limiter.waiting("a")).toBe(0);
    release();
    expect(limiter.active("a")).toBe(0);
  });
});
