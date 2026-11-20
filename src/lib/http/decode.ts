// Body decoding of SafeHttp (specification §11.1): content codings (gzip,
// deflate, br) as a stream, and the text decoding with the right charset.
import { pipeline, Transform, type Readable, type TransformCallback } from "node:stream";
import zlib from "node:zlib";
import { HttpError } from "./types";

/** The value of the Accept-Encoding header: the codings that SafeHttp decodes. */
export const SUPPORTED_ENCODINGS = "gzip, deflate, br";

/** The codings of a Content-Encoding header, in the order that the server applied them. */
export function parseContentEncoding(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "" && part !== "identity");
}

// Truncated streams are common on the web. The flush modes below give the
// bytes that arrived instead of an error at the end of the stream.
const ZLIB_OPTIONS: zlib.ZlibOptions = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
const BROTLI_OPTIONS: zlib.BrotliOptions = { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH };

/**
 * "deflate" is the zlib format (RFC 9110), but some servers send raw deflate.
 * This stream reads the first two bytes and picks the right inflater.
 */
class AutoInflate extends Transform {
  #inner: zlib.Inflate | zlib.InflateRaw | null = null;
  #head: Buffer = Buffer.alloc(0);

  #start(): zlib.Inflate | zlib.InflateRaw {
    const b0 = this.#head[0] ?? 0;
    const b1 = this.#head[1] ?? 0;
    const zlibHeader = this.#head.length >= 2 && (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0;
    const inner = zlibHeader ? zlib.createInflate(ZLIB_OPTIONS) : zlib.createInflateRaw(ZLIB_OPTIONS);
    inner.on("data", (chunk: Buffer) => this.push(chunk));
    inner.on("error", (error: Error) => this.destroy(error));
    this.#inner = inner;
    return inner;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let inner = this.#inner;
    let input = chunk;
    if (!inner) {
      this.#head = Buffer.concat([this.#head, chunk]);
      if (this.#head.length < 2) {
        callback();
        return;
      }
      input = this.#head;
      inner = this.#start();
      this.#head = Buffer.alloc(0);
    }
    inner.write(input, () => callback());
  }

  override _flush(callback: TransformCallback): void {
    let inner = this.#inner;
    if (!inner) {
      if (this.#head.length === 0) {
        callback();
        return;
      }
      inner = this.#start();
      inner.write(this.#head);
    }
    inner.once("end", () => callback());
    inner.end();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#inner?.destroy();
    callback(error);
  }
}

function decoderFor(coding: string): Transform {
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip(ZLIB_OPTIONS);
    case "deflate":
      return new AutoInflate();
    case "br":
      return zlib.createBrotliDecompress(BROTLI_OPTIONS);
    default:
      throw new HttpError("network", "The server sent a body with a content encoding that the app does not support.");
  }
}

/**
 * The decoded body as a stream. Errors of any stage arrive as an 'error'
 * event of the returned stream. Throws HttpError for an unknown coding.
 */
export function decodedStream(body: Readable, codings: readonly string[]): Readable {
  if (codings.length === 0) return body;
  if (codings.length > 3) throw new HttpError("network", "The server sent a body with too many content encodings.");
  // The server applied the codings in the listed order: undo them in reverse.
  const decoders = [...codings].reverse().map(decoderFor);
  const streams: Array<Readable | Transform> = [body, ...decoders];
  // The callback is needed by the API; errors reach the last stream.
  return pipeline(streams as [Readable, ...Transform[]], () => undefined) as unknown as Readable;
}

// ---------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------

function supportedLabel(label: string | undefined): string | null {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return null;
  }
}

/** The charset parameter of a Content-Type header value. */
export function charsetFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  return supportedLabel(match?.[1] ?? match?.[2]);
}

function charsetFromBom(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return null;
}

/** The encoding of an XML declaration, else a `<meta charset>` of HTML, in the first 1024 bytes. */
export function charsetFromDocument(bytes: Uint8Array): string | null {
  // latin1 maps each byte to one character: safe for an ASCII search.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const xml = /^\s*<\?xml\s[^>]*?encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head);
  const meta =
    /<meta\s[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
  const label = supportedLabel(xml?.[1] ?? meta?.[1]);
  // The bytes are ASCII-compatible here (the search found the text), so a
  // declared UTF-16 is wrong: the encoding standard reads it as UTF-8.
  if (label === "utf-16le" || label === "utf-16be") return "utf-8";
  return label;
}

// The bytes 0x80-0x9F of windows-1252 (the encoding standard also uses this
// table for the labels iso-8859-1, latin1, and us-ascii). The TextDecoder of
// Node 20 maps these bytes to C1 control characters, which is wrong: this
// module decodes windows-1252 itself.
const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  const step = 8192;
  for (let start = 0; start < bytes.length; start += step) {
    const codes: number[] = [];
    const end = Math.min(bytes.length, start + step);
    for (let i = start; i < end; i += 1) {
      const byte = bytes[i] ?? 0;
      codes.push(byte >= 0x80 && byte <= 0x9f ? (WINDOWS_1252_HIGH[byte - 0x80] ?? byte) : byte);
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * Decodes a body: a byte order mark first, then the charset of the
 * Content-Type header, then the XML declaration (or HTML meta charset), else
 * UTF-8. Bytes that are not valid become U+FFFD.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined): string {
  if (bytes.length === 0) return "";
  const encoding =
    charsetFromBom(bytes) ?? charsetFromContentType(contentType) ?? charsetFromDocument(bytes) ?? "utf-8";
  if (encoding === "windows-1252") return decodeWindows1252(bytes);
  return new TextDecoder(encoding).decode(bytes);
}
