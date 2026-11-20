import { parseAttributes } from "./attrs";
import { decodeEntities } from "./entities";

const TRACKING_NAMES = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src", "ref_url",
]);
const MAX_LINKS = 50;

function isTrackingName(rawName: string): boolean {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    // A name with a bad escape stays as it is.
  }
  name = name.toLowerCase();
  return name.startsWith("utm_") || TRACKING_NAMES.has(name);
}

function parseHttpUrl(text: string, base?: string): URL | null {
  try {
    const u = base === undefined ? new URL(text) : new URL(text, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * The canonical form of an http(s) URL: lower-case scheme and host, no default port, no fragment,
 * no tracking parameters (`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`,
 * `igshid`, `ref`, `ref_src`, `ref_url`), the other parameters in their order, and no "/" at the
 * end of the path (the root path stays "/"). The scheme does not change. An input that is not an
 * http(s) URL comes back trimmed.
 */
export function canonicalizeUrl(url: string): string {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const u = parseHttpUrl(trimmed);
  if (u === null) return trimmed;
  u.hash = "";
  const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  const kept = query.split("&").filter((part) => {
    if (part === "") return false;
    const eq = part.indexOf("=");
    return !isTrackingName(eq < 0 ? part : part.slice(0, eq));
  });
  u.search = kept.join("&");
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    const path = u.pathname.replace(/\/+$/, "");
    u.pathname = path === "" ? "/" : path;
  }
  return u.href;
}

/** True for an http(s) URL with the path "/" (or no path) and no query after canonicalization. */
export function isRootUrl(url: string): boolean {
  const u = parseHttpUrl(canonicalizeUrl(url));
  return u !== null && (u.pathname === "/" || u.pathname === "") && u.search === "";
}

// One of: an <a> or <area> tag, any other tag or comment (skipped), a bare URL in the text.
const LINK_SCAN =
  /<(?:a|area)(\s[^>]*)>|<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|\bhttps?:\/\/[^\s<>"'`\\^{}|]+/gi;
const SCRIPT_OR_STYLE = /<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

function trimBareUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.charAt(url.length - 1);
    if (".,;:!?'\"…»*_~".includes(last)) {
      url = url.slice(0, -1);
    } else if (last === ")" && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) {
      url = url.slice(0, -1);
    } else if (last === "]" && (url.match(/\]/g) ?? []).length > (url.match(/\[/g) ?? []).length) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

/**
 * The http(s) links of an HTML fragment or a plain text: the `href` values of <a> elements and the
 * URLs in the text, in document order, canonical, with no duplicates, at most 50. A relative
 * `href` counts only when `baseUrl` is given.
 */
export function extractLinks(htmlOrText: string, baseUrl?: string): string[] {
  if (typeof htmlOrText !== "string" || htmlOrText === "") return [];
  const base = baseUrl !== undefined && parseHttpUrl(baseUrl) !== null ? baseUrl : undefined;
  const source = htmlOrText.replace(SCRIPT_OR_STYLE, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (u: URL | null): void => {
    if (u === null) return;
    const canonical = canonicalizeUrl(u.href);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push(canonical);
  };
  LINK_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (out.length < MAX_LINKS && (match = LINK_SCAN.exec(source)) !== null) {
    const whole = match[0];
    if (whole.charCodeAt(0) === 60 /* < */) {
      if (match[1] === undefined) continue;
      const href = (parseAttributes(match[1])["href"] ?? "").trim();
      if (href === "" || href.startsWith("#")) continue;
      if (/^https?:\/\//i.test(href)) add(parseHttpUrl(href));
      else if (base !== undefined && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) add(parseHttpUrl(href, base));
      continue;
    }
    // A decoded reference can give a space (for example "&nbsp;"): the URL ends there.
    add(parseHttpUrl(trimBareUrl(decodeEntities(whole).replace(/\s[\s\S]*$/, ""))));
  }
  return out;
}
