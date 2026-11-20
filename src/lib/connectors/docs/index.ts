// The `docs` connector (specification §6.3): a page watch for documentation and changelog pages.
// Each poll fetches the page (conditional GET), splits it into sections by heading, and compares
// them with the snapshot in the cursor. "changelog" pages give one item for each new entry (and
// for a meaningful edit of a known entry); "page" pages give one item for each new or changed
// section.
import { discoverFeeds } from "@/lib/feeds";
import { HttpError, type HttpResponse } from "@/lib/http/types";
import { splitSections, type Section } from "@/lib/text";
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, docsConfigSchema, sourceKey, type DocsConfig } from "../configs";
import { ConnectorError, type Candidate, type Connector, type ConnectorContext } from "../types";
import { analyzeSections, changelogEntries, detectMode } from "./entries";
import { linksByText, looksLikeFeed, pageTitle, revealDeferredContent } from "./page";
import { pollChangelog, pollPage, previewChangelog, previewPage, type DocsCursor, type WatchPage } from "./watch";

export type { DocsCursor, DocsSnapshotSection } from "./watch";
export { PAGE_PREVIEW_NOTE } from "./watch";

const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";

function transportError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof HttpError) {
    switch (error.kind) {
      case "timeout":
        return new ConnectorError("network", "The page did not answer in time.", { cause: error });
      case "too_large":
        return new ConnectorError("bad_response", "The page is too large to watch.", { cause: error });
      case "too_many_redirects":
        return new ConnectorError("bad_response", "The page redirected too many times.", { cause: error });
      case "bad_url":
        return new ConnectorError("blocked", "The page address is not valid.", { cause: error });
      case "blocked_address":
        return new ConnectorError("blocked", "The app does not send requests to this address.", { cause: error });
      default:
        return new ConnectorError("network", "The page could not be reached.", { cause: error });
    }
  }
  return new ConnectorError("network", "The page could not be reached.", { cause: error });
}

function statusError(res: HttpResponse): ConnectorError {
  const s = res.status;
  if (s === 404 || s === 410) return new ConnectorError("not_found", `The page address returned ${s}.`);
  if (s === 429) return new ConnectorError("rate_limited", "The site limits requests from this server (429). The next check tries again.");
  if (s === 401 || s === 403 || s === 451) return new ConnectorError("blocked", `The site refused the request (${s}).`);
  return new ConnectorError("bad_response", `The page answered with status ${s}.`);
}

/** The sections of a page response. Throws ConnectorError for a feed or a page with no sections. */
function readSections(res: HttpResponse, config: DocsConfig): { html: string; sections: Section[] } {
  if (looksLikeFeed(res.headers["content-type"], res.text)) {
    throw new ConnectorError("bad_response", "This address returns a feed, not a page. Add it as an engineering blog.");
  }
  const html = revealDeferredContent(res.text);
  const sections = splitSections(html, config.selector);
  if (sections.length === 0) {
    throw new ConnectorError(
      "bad_response",
      config.selector
        ? `The CSS selector "${config.selector}" matches no text on the page.`
        : "The page has no readable text. Set a CSS selector for the main content.",
    );
  }
  return { html, sections };
}

/** An http(s) address from the input: a full address, or a host name with a dot and an optional path. */
function pageAddress(input: string): URL | null {
  const text = input.trim();
  if (text === "" || /\s/.test(text)) return null;
  let candidate = text;
  if (!/^https?:\/\//i.test(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.includes("@")) return null;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:[/?#]\S*)?$/i.test(text)) return null;
    candidate = `https://${text}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/** Addresses that another source type follows; a docs candidate only when the person chose the type. */
function belongsToOtherType(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (/^(?:x|twitter|mobile\.twitter)\.com$/.test(host)) return true;
  if (/(?:^|\.)(?:youtube\.com|youtu\.be|reddit\.com|spotify\.com)$/.test(host)) return true;
  if (host === "news.ycombinator.com" || host === "podcasts.apple.com") return true;
  if (host === "github.com") {
    const parts = url.pathname.split("/").filter((p) => p !== "");
    return parts.length <= 2 || ["releases", "tags", "discussions", "issues", "pulls", "security"].includes(parts[2] ?? "");
  }
  return false;
}

async function resolveDocs(input: string, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]> {
  const url = pageAddress(input);
  if (url === null) return [];
  if (!forced && belongsToOtherType(url)) return [];

  const config = (address: string) => docsConfigSchema.parse({ url: address, mode: "auto", ignoreMinorEdits: true });
  const unchecked = (warning: string): Candidate[] =>
    forced
      ? [
          {
            type: "docs",
            name: url.hostname + (url.pathname === "/" ? "" : url.pathname),
            description: "Documentation or changelog page. New entries and meaningful edits become items.",
            url: url.href,
            config: config(url.href),
            confidence: 0.3,
            warnings: [warning],
          },
        ]
      : [];

  let res: HttpResponse;
  try {
    res = await ctx.http.request({
      url: url.href,
      headers: { Accept: PAGE_ACCEPT },
      timeoutMs: 10_000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (error) {
    if (error instanceof HttpError && (error.kind === "bad_url" || error.kind === "blocked_address")) return [];
    return unchecked(transportError(error).message);
  }
  if (res.status === 404 || res.status === 410) return [];
  if (!res.ok) return unchecked(statusError(res).message);
  if (looksLikeFeed(res.headers["content-type"], res.text)) return [];
  const type = (res.headers["content-type"] ?? "").toLowerCase();
  if (type !== "" && !/html|xml|text\/plain/.test(type)) return [];

  const finalUrl = res.url && /^https?:\/\//i.test(res.url) ? res.url.replace(/#.*$/, "") : url.href;
  const html = revealDeferredContent(res.text);
  const sections = splitSections(html);
  const analyzed = analyzeSections(sections);
  const mode = detectMode(analyzed);
  const feeds = discoverFeeds(res.text, finalUrl);
  const warnings: string[] = [];
  let description: string;
  let confidence: number;
  if (sections.length === 0) {
    description = "Documentation or changelog page.";
    warnings.push("The app found no readable text on this page. Set a CSS selector for the main content.");
    confidence = 0.3;
  } else if (mode === "changelog") {
    const count = changelogEntries(analyzed).length;
    description = `Changelog page with ${count} dated ${count === 1 ? "entry" : "entries"}. New entries become items.`;
    confidence = 0.75;
  } else {
    description = `Documentation page with ${sections.length} ${sections.length === 1 ? "section" : "sections"}. New and changed sections become items.`;
    confidence = 0.6;
  }
  if (feeds.length > 0) {
    warnings.push("This page has a feed. An engineering blog source reads the feed more reliably.");
    confidence = Math.min(confidence, 0.35);
  }
  return [
    {
      type: "docs",
      name: pageTitle(res.text, finalUrl),
      description,
      url: finalUrl,
      config: config(finalUrl),
      confidence,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  ];
}

export const connector: Connector<DocsConfig, DocsCursor> = {
  type: "docs",
  label: SOURCE_TYPE_LABELS.docs,
  description: "A documentation or changelog page: new entries and meaningful edits.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.docs.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.docs.maxAgeDays,
  configSchema: docsConfigSchema,
  needs: (env, config) => credentialNeeds("docs", env, config),
  keyOf: (config) => sourceKey("docs", config),

  resolve(input, ctx, forced) {
    return resolveDocs(input, ctx, forced);
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const preview = mode === "preview";
    const max = Math.max(0, limit);
    // A cursor of another mode (the person changed the mode) starts a new baseline.
    const fixedMode = config.mode === "auto" ? null : config.mode;
    const previous = !preview && cursor !== null && (fixedMode === null || cursor.mode === fixedMode) ? cursor : null;

    let res: HttpResponse;
    try {
      res = await ctx.http.request({
        url: config.url,
        headers: { Accept: PAGE_ACCEPT },
        ...(previous?.etag ? { etag: previous.etag } : {}),
        ...(previous?.lastModified ? { lastModified: previous.lastModified } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      throw transportError(error);
    }
    if (previous !== null && (res.notModified || res.status === 304)) return { items: [], cursor: previous };
    if (!res.ok) throw statusError(res);

    const { html, sections } = readSections(res, config);
    const analyzed = analyzeSections(sections);
    const resolvedMode = fixedMode ?? previous?.mode ?? detectMode(analyzed);
    const page: WatchPage = {
      url: res.url && /^https?:\/\//i.test(res.url) ? res.url : config.url,
      title: pageTitle(res.text, config.url),
      linksByText: linksByText(html, res.url || config.url),
      ignoreMinorEdits: config.ignoreMinorEdits,
    };

    if (preview) {
      const items =
        resolvedMode === "changelog"
          ? previewChangelog(changelogEntries(analyzed), page, max)
          : previewPage(sections, page, max);
      return { items, cursor: null };
    }

    const next: DocsCursor = { mode: resolvedMode, sections: [], seenEntryIds: [] };
    if (res.etag) next.etag = res.etag;
    if (res.lastModified) next.lastModified = res.lastModified;
    if (resolvedMode === "changelog") {
      const result = pollChangelog({ entries: changelogEntries(analyzed), previous, page, limit: max });
      next.sections = result.sections;
      next.seenEntryIds = result.seenEntryIds;
      return { items: result.items, cursor: next };
    }
    const result = pollPage({ sections, previous, page, limit: max });
    next.sections = result.sections;
    return { items: result.items, cursor: next };
  },
};
