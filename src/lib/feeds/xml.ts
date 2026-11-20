import { XMLParser } from "fast-xml-parser";

import { decodeEntities } from "@/lib/text";

/** A node of the parsed XML tree: text, an element (child names and "@_" attributes), or a list. */
export type XmlNode = string | XmlObject | XmlNode[];
export interface XmlObject {
  [key: string]: XmlNode;
}

const TEXT = "#text";
const CDATA = "__cdata";
const ATTR = "@_";

/** Canonical prefix for each namespace that the feed code reads. */
const NAMESPACES: Record<string, string> = {
  "http://purl.org/rss/1.0/modules/content": "content",
  "http://purl.org/dc/elements/1.1": "dc",
  "http://purl.org/dc/terms": "dcterms",
  "http://www.itunes.com/dtds/podcast-1.0.dtd": "itunes",
  "https://podcastindex.org/namespace/1.0": "podcast",
  "https://github.com/podcastindex-org/podcast-namespace/blob/main/docs/1.0.md": "podcast",
  "http://search.yahoo.com/mrss": "media",
  "http://www.youtube.com/xml/schemas/2015": "yt",
  "http://www.w3.org/2005/atom": "atom",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
  "http://purl.org/rss/1.0": "rss1",
  "http://www.google.com/schemas/play-podcasts/1.0": "googleplay",
};

function namespaceKey(uri: string): string {
  return uri.trim().toLowerCase().replace(/^https:\/\/www\.itunes\.com/, "http://www.itunes.com").replace(/\/+$/, "");
}

// Entities are not processed by the parser: its limits on entity expansion fail on large feeds, and
// a DOCTYPE cannot expand anything this way. The feed code decodes text and attribute values itself.
// The stop nodes keep the raw content of Atom text constructs (type="xhtml" has child elements).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  textNodeName: TEXT,
  cdataPropName: CDATA,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  allowBooleanAttributes: true,
  stopNodes: ["*.title", "*.content", "*.summary", "*.subtitle", "*.rights"],
});

export function isObject(node: XmlNode | undefined): node is XmlObject {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

export function asArray(node: XmlNode | undefined): XmlNode[] {
  if (node === undefined) return [];
  return Array.isArray(node) ? node : [node];
}

/** The first node of a list, or the node itself. */
export function first(node: XmlNode | undefined): XmlNode | undefined {
  return Array.isArray(node) ? node[0] : node;
}

/** Raw XML character data to a string: CDATA sections as they are, references decoded in the rest. */
export function decodeRaw(raw: string): string {
  if (!raw.includes("<![CDATA[")) return decodeEntities(raw);
  let out = "";
  let i = 0;
  for (;;) {
    const start = raw.indexOf("<![CDATA[", i);
    if (start < 0) return out + decodeEntities(raw.slice(i));
    out += decodeEntities(raw.slice(i, start));
    const end = raw.indexOf("]]>", start + 9);
    if (end < 0) return out + raw.slice(start + 9);
    out += raw.slice(start + 9, end);
    i = end + 3;
  }
}

function deepText(node: XmlNode): string {
  if (typeof node === "string") return decodeRaw(node);
  if (Array.isArray(node)) return node.map(deepText).join(" ");
  let out = "";
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(ATTR)) continue;
    out += key === CDATA ? asArray(value).filter((v) => typeof v === "string").join("") : deepText(value);
  }
  return out;
}

/** The text of an element (references decoded, CDATA joined), trimmed. "" when there is none. */
export function textOf(node: XmlNode | undefined): string {
  const n = first(node);
  if (n === undefined) return "";
  if (typeof n === "string") return decodeRaw(n).trim();
  if (!isObject(n)) return "";
  const text = typeof n[TEXT] === "string" ? decodeRaw(n[TEXT]) : "";
  const cdata = asArray(n[CDATA]).filter((v): v is string => typeof v === "string").join("");
  if (text.trim() !== "" || cdata !== "") return (text.trim() === "" ? cdata : text + cdata).trim();
  // An element with child elements only (XHTML in a document where the stop nodes did not match).
  return deepText(n).trim();
}

/** The raw content of a stop node (not decoded). */
export function rawOf(node: XmlNode | undefined): string {
  const n = first(node);
  if (typeof n === "string") return n;
  if (!isObject(n)) return "";
  if (typeof n[TEXT] === "string") return n[TEXT];
  return asArray(n[CDATA]).filter((v): v is string => typeof v === "string").map((v) => `<![CDATA[${v}]]>`).join("");
}

/** The value of an attribute (references decoded, trimmed). undefined when the attribute is absent. */
export function attr(node: XmlNode | undefined, name: string): string | undefined {
  const n = first(node);
  if (!isObject(n)) return undefined;
  const value = n[ATTR + name];
  return typeof value === "string" ? decodeEntities(value).trim() : undefined;
}

/**
 * A plain copy of a node for `FeedEntry.extra`: text as a string; an element with attributes or
 * children as an object (attribute names with no prefix, the text under "#text").
 */
export function simplify(node: XmlNode): unknown {
  if (typeof node === "string") return decodeRaw(node).trim();
  if (Array.isArray(node)) return node.map(simplify);
  const out: Record<string, unknown> = {};
  let text = "";
  for (const [key, value] of Object.entries(node)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (key === TEXT) {
      if (typeof value === "string") text = decodeRaw(value) + text;
    } else if (key === CDATA) {
      text += asArray(value).filter((v) => typeof v === "string").join("");
    } else if (key.startsWith(ATTR)) {
      if (!key.startsWith(`${ATTR}xmlns`) && typeof value === "string") out[key.slice(ATTR.length)] = decodeEntities(value);
    } else {
      out[key] = simplify(value);
    }
  }
  text = text.trim();
  if (Object.keys(out).length === 0) return text;
  if (text !== "") out[TEXT] = text;
  return out;
}

function renameKeys(node: XmlNode, rename: Map<string, string>): XmlNode {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((n) => renameKeys(n, rename));
  const out: XmlObject = {};
  for (const [key, value] of Object.entries(node)) {
    const isAttr = key.startsWith(ATTR);
    const name = isAttr ? key.slice(ATTR.length) : key;
    const colon = name.indexOf(":");
    let next = name;
    if (colon > 0 && !name.startsWith("xmlns") && !name.startsWith("xml:")) {
      const target = rename.get(name.slice(0, colon));
      if (target !== undefined) next = target === "" ? name.slice(colon + 1) : `${target}:${name.slice(colon + 1)}`;
    }
    const outKey = isAttr ? ATTR + next : next;
    if (outKey === "__proto__") continue;
    out[outKey] = isAttr ? value : renameKeys(value, rename);
  }
  return out;
}

export interface XmlRoot {
  /** "rss", "feed", or "rdf:RDF" in lower case ("rdf:rdf"); other names for documents that are not feeds. */
  name: string;
  node: XmlObject;
}

/**
 * Parses an XML document and returns its root element. Namespace prefixes become the canonical
 * ones ("content", "dc", "itunes", "podcast", "media", "yt", "atom"), so a feed that declares
 * another prefix for the same namespace reads the same. Returns null when there is no root element.
 */
export function parseXml(xml: string): XmlRoot | null {
  const parsed = parser.parse(xml) as XmlObject;
  let rootName = Object.keys(parsed).find((k) => k !== TEXT && !k.startsWith("?") && !k.startsWith("!"));
  if (rootName === undefined) return null;
  let root = first(parsed[rootName]);
  if (!isObject(root)) return null;

  // Prefix declarations, from the whole document.
  const prefixes = new Map<string, string>();
  for (const m of xml.matchAll(/\sxmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const canonical = NAMESPACES[namespaceKey(m[2] ?? m[3] ?? "")];
    if (canonical !== undefined && m[1] !== undefined && !prefixes.has(m[1])) prefixes.set(m[1], canonical);
  }
  const rootColon = rootName.indexOf(":");
  const rootPrefix = rootColon > 0 ? rootName.slice(0, rootColon) : "";
  const rootLocal = rootColon > 0 ? rootName.slice(rootColon + 1) : rootName;
  const atomDocument = rootLocal.toLowerCase() === "feed" && (rootPrefix === "" || prefixes.get(rootPrefix) === "atom");
  const rename = new Map<string, string>();
  for (const [prefix, canonical] of prefixes) {
    // Prefixed elements of the document's own vocabulary lose the prefix.
    const target = (canonical === "atom" && atomDocument) || canonical === "rss1" ? "" : canonical;
    if (target !== prefix) rename.set(prefix, target);
  }
  if (rename.size > 0) {
    const wrapped = renameKeys({ [rootName]: root }, rename);
    if (isObject(wrapped)) {
      rootName = Object.keys(wrapped)[0] ?? rootName;
      const renamed = wrapped[rootName];
      if (isObject(renamed)) root = renamed;
    }
  }
  return { name: rootName.toLowerCase(), node: root };
}
