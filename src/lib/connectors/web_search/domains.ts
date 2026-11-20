// Domain rules of the web_search connector (specification §6.3). Pure.

/** The lower-case host of an http(s) URL, or null. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** True when the host is the domain or a subdomain of it ("docs.example.com" matches "example.com"). */
export function hostMatches(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\*?\.+/, "").replace(/\.$/, "");
  if (d === "") return false;
  return host === d || host.endsWith(`.${d}`);
}

/**
 * True when the URL passes the domain lists: an excluded domain always
 * removes it; with allowed domains, the host must match one of them.
 */
export function domainAllowed(url: string, allowedDomains: string[], excludedDomains: string[]): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  if (excludedDomains.some((d) => hostMatches(host, d))) return false;
  if (allowedDomains.length === 0) return true;
  return allowedDomains.some((d) => hostMatches(host, d));
}

/** At most this many allowed domains go into the query as site: terms. */
export const MAX_SITE_TERMS = 3;

/** The query that goes to the search provider: the words, plus site: terms for 1 to 3 allowed domains. */
export function buildWebQuery(query: string, allowedDomains: string[]): string {
  const words = query.trim().replace(/\s+/g, " ");
  if (allowedDomains.length === 0 || allowedDomains.length > MAX_SITE_TERMS) return words;
  const sites = allowedDomains.map((d) => `site:${d}`);
  return `${words} ${sites.length === 1 ? sites[0] : sites.join(" OR ")}`;
}

/**
 * Splits "site:" and "-site:" terms out of a typed query, for the resolve
 * step: "agent evals site:openai.com -site:reddit.com" ->
 * { query: "agent evals", allowed: ["openai.com"], excluded: ["reddit.com"] }.
 */
export function splitSiteTerms(input: string): { query: string; allowed: string[]; excluded: string[] } {
  const allowed: string[] = [];
  const excluded: string[] = [];
  const rest: string[] = [];
  for (const word of input.trim().split(/\s+/)) {
    const m = /^(-?)site:([^\s/]+)\/?$/i.exec(word);
    if (m) {
      const domain = m[2]!.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
      (m[1] ? excluded : allowed).push(domain);
    } else if (word !== "") {
      rest.push(word);
    }
  }
  // "a.com OR site:b.com": the OR belonged to the site terms.
  const words = allowed.length > 1 ? rest.filter((word) => word !== "OR") : rest;
  return { query: words.join(" "), allowed: [...new Set(allowed)], excluded: [...new Set(excluded)] };
}
