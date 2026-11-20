// The `newsletter` connector (specification §6.3): the issues of a
// newsletter, from its feed (variant "feed") or from the dedicated mailbox
// (variant "inbox", through ctx.mail only).
import type { ParsedFeed } from "@/lib/feeds";
import { MailError } from "@/lib/mail/errors";
import type { MailMessage } from "@/lib/mail/types";
import { LIMITS, SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { feedDescription, feedName, fetchFeedItems, isOtherTypeHost } from "../blog";
import { findFeeds, type FindFeedsResult } from "../blog/discover";
import { loadFeed, looksLikePodcast, type FeedCursor } from "../blog/feed-source";
import { PAGE_ACCEPT, assertOk, bareHost, httpGet, inputUrl } from "../blog/http";
import { credentialNeeds, newsletterConfigSchema, sourceKey, type NewsletterConfig } from "../configs";
import { ConnectorError, type Candidate, type Connector, type ConnectorContext, type FetchResult } from "../types";
import {
  PREVIEW_LIMIT,
  RESET_LIMIT,
  messageToItem,
  parseSenderInput,
  readInboxCursor,
  senderAddress,
  type InboxCursor,
} from "./inbox";

export { findViewInBrowserLink, messageToItem, parseSenderInput, senderAddress, type InboxCursor } from "./inbox";

/** The cursor of a newsletter: the feed cursor (variant feed) or the mailbox cursor (variant inbox). */
export type NewsletterCursor = FeedCursor | InboxCursor;

export type NewsletterPlatform = "substack" | "beehiiv" | "ghost" | "buttondown";

const PLATFORM_LABEL: Record<NewsletterPlatform, string> = {
  substack: "Substack",
  beehiiv: "beehiiv",
  ghost: "Ghost",
  buttondown: "Buttondown",
};

/** The platform and its feed address, from the address alone (no request). */
export function platformOfUrl(url: URL): { platform: NewsletterPlatform; feedUrl: string } | null {
  const host = bareHost(url);
  if (host.endsWith(".substack.com") && host !== "substack.com") return { platform: "substack", feedUrl: `${url.origin}/feed` };
  if (host.endsWith(".beehiiv.com") && host !== "beehiiv.com") return { platform: "beehiiv", feedUrl: `${url.origin}/feed` };
  if (host.endsWith(".ghost.io")) return { platform: "ghost", feedUrl: `${url.origin}/rss/` };
  if (host === "buttondown.com" || host === "buttondown.email") {
    const name = url.pathname.split("/").filter(Boolean)[0];
    if (name && /^[A-Za-z0-9_-]{1,100}$/.test(name) && !["login", "register", "pricing", "features", "blog", "docs"].includes(name)) {
      return { platform: "buttondown", feedUrl: `https://buttondown.com/${name}/rss` };
    }
  }
  return null;
}

/** The platform from the marks of a page (custom domains). */
export function platformOfPage(html: string): NewsletterPlatform | null {
  const head = html.slice(0, 400_000);
  if (/substackcdn\.com|<meta[^>]+content="Substack"/i.test(head)) return "substack";
  if (/<meta[^>]+name="generator"[^>]+content="Ghost\b/i.test(head)) return "ghost";
  if (/<meta[^>]+name="generator"[^>]+content="Buttondown/i.test(head)) return "buttondown";
  if (/beehiiv\.com|beehiiv-images/i.test(head)) return "beehiiv";
  return null;
}

/** The feed paths to try first for each platform. */
const PLATFORM_PATHS: Record<NewsletterPlatform, readonly string[]> = {
  substack: ["/feed"],
  beehiiv: ["/feed"],
  ghost: ["/rss/"],
  buttondown: ["rss"],
};

function feedCandidate(
  feedUrl: string,
  feed: ParsedFeed,
  html: string,
  platform: NewsletterPlatform | null,
  confidence: number,
): Candidate {
  const config: NewsletterConfig = newsletterConfigSchema.parse({ variant: "feed", feedUrl });
  const warnings: string[] = [];
  if (feed.entries.length === 0) warnings.push("The feed has no issues yet.");
  return {
    type: "newsletter",
    name: feedName(feed, html, feedUrl),
    description: `${platform ? `${PLATFORM_LABEL[platform]} newsletter. ` : ""}${feedDescription(feed, "issues")}`,
    url: feed.siteUrl ?? feedUrl,
    config,
    confidence: looksLikePodcast(feed) ? Math.min(confidence, 0.4) : confidence,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function inboxCandidate(sender: string, ctx: ConnectorContext, forced: boolean): Candidate {
  const config: NewsletterConfig = { variant: "inbox", sender };
  const need = credentialNeeds("newsletter", ctx.env, config);
  return {
    type: "newsletter",
    name: sender.slice(0, LIMITS.name),
    description: `Emails from ${sender} in the newsletter mailbox. Subscribe the mailbox address to this newsletter.`,
    config,
    confidence: forced ? 0.95 : 0.9,
    ...(need ? { warnings: [need.message] } : {}),
  };
}

async function resolveFeed(url: URL, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]> {
  const known = platformOfUrl(url);
  if (known) {
    try {
      const doc = await loadFeed(ctx, known.feedUrl);
      if (!doc.notModified) return [feedCandidate(doc.url, doc.feed, "", known.platform, 0.95)];
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      // Fall back to the page and its feed links.
    }
  }

  let first;
  try {
    first = await httpGet(ctx, url.href, { accept: PAGE_ACCEPT });
    assertOk(first, "The address");
  } catch (error) {
    if (forced) throw error;
    return [];
  }
  const platform = known?.platform ?? platformOfPage(first.text);
  if (!platform && !forced) return [];
  const found: FindFeedsResult = await findFeeds(ctx, url.href, {
    first,
    ...(platform ? { preferredPaths: PLATFORM_PATHS[platform] } : {}),
  });
  return found.feeds.map((f, index) =>
    feedCandidate(f.feedUrl, f.feed, found.html, platform, (platform ? 0.92 : 0.6) - index * 0.05),
  );
}

function mailError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof MailError) {
    if (error.kind === "auth") return new ConnectorError("needs_credentials", error.message, { cause: error });
    if (error.kind === "not_found") return new ConnectorError("not_found", error.message, { cause: error });
    if (error.kind === "bad_response") return new ConnectorError("bad_response", error.message, { cause: error });
    return new ConnectorError("network", error.message, { cause: error });
  }
  return new ConnectorError("network", "The app could not read the newsletter mailbox.", { cause: error });
}

async function fetchInbox(
  config: Extract<NewsletterConfig, { variant: "inbox" }>,
  rawCursor: unknown,
  mode: "preview" | "poll",
  limit: number,
  ctx: ConnectorContext,
): Promise<FetchResult<NewsletterCursor>> {
  if (!ctx.mail) {
    const need = credentialNeeds("newsletter", ctx.env, config);
    throw new ConnectorError(
      "needs_credentials",
      need?.message ?? "The newsletter mailbox is not set up. Add IMAP_HOST, IMAP_USER, and IMAP_PASSWORD to the .env file.",
    );
  }
  const mail = ctx.mail;
  const sender = config.sender.toLowerCase();
  const subject = config.subjectIncludes?.toLowerCase();
  const list = async (sinceUid: number | null, n: number) => {
    try {
      return await mail.list({
        from: sender,
        ...(config.subjectIncludes ? { subjectIncludes: config.subjectIncludes } : {}),
        sinceUid,
        limit: Math.max(0, Math.floor(n)),
      });
    } catch (error) {
      throw mailError(error);
    }
  };
  // IMAP FROM and SUBJECT search for a part of the text: the exact rules run here.
  const toItems = (messages: MailMessage[]) =>
    [...messages]
      .filter((m) => senderAddress(m.from) === sender)
      .filter((m) => !subject || m.subject.toLowerCase().includes(subject))
      .sort((a, b) => b.uid - a.uid || b.date - a.date)
      .slice(0, Math.max(0, limit))
      .map(messageToItem);
  const maxUid = (messages: MailMessage[], floor: number) => messages.reduce((max, m) => Math.max(max, m.uid), floor);

  if (mode === "preview") {
    const r = await list(null, Math.min(limit, PREVIEW_LIMIT));
    return { items: toItems(r.messages), cursor: null };
  }

  const cursor = readInboxCursor(rawCursor);
  if (!cursor) {
    const r = await list(null, limit);
    return { items: toItems(r.messages), cursor: { uidValidity: r.uidValidity, lastUid: maxUid(r.messages, 0) } };
  }

  const r = await list(cursor.lastUid, limit);
  if (r.uidValidity !== cursor.uidValidity) {
    // The UIDs of the mailbox changed: start again from the newest messages (the pipeline skips known Message-IDs).
    const again = await list(null, Math.min(limit, RESET_LIMIT));
    return { items: toItems(again.messages), cursor: { uidValidity: again.uidValidity, lastUid: maxUid(again.messages, 0) } };
  }
  const fresh = r.messages.filter((m) => m.uid > cursor.lastUid);
  return { items: toItems(fresh), cursor: { uidValidity: cursor.uidValidity, lastUid: maxUid(fresh, cursor.lastUid) } };
}

export const connector: Connector<NewsletterConfig, NewsletterCursor> = {
  type: "newsletter",
  label: SOURCE_TYPE_LABELS.newsletter,
  description: "Issues of a newsletter, from its feed or from the dedicated mailbox.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.newsletter.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.newsletter.maxAgeDays,
  configSchema: newsletterConfigSchema,
  needs: (env, config) => credentialNeeds("newsletter", env, config),
  keyOf: (config) => sourceKey("newsletter", config),

  async resolve(input, ctx, forced) {
    const sender = parseSenderInput(input);
    if (sender) return [inboxCandidate(sender, ctx, forced)];
    const url = inputUrl(input);
    if (!url) return [];
    if (!forced && isOtherTypeHost(url)) return [];
    return resolveFeed(url, ctx, forced);
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const parsed = newsletterConfigSchema.parse(config);
    if (parsed.variant === "inbox") return fetchInbox(parsed, cursor, mode, limit, ctx);
    return fetchFeedItems({ feedUrl: parsed.feedUrl, cursor, mode, limit, ctx, kind: "article" });
  },
};
