// The config schema of each source type (specification §6.3) and the single
// definition of the canonical identity of a source (`sources.key`).
//
// The phase 2 connector files import their schema, their config type,
// `sourceKey`, and `credentialNeeds` from this file. They do not change it.
import { z } from "zod";

// Type-only import: this file must stay safe for client components (the
// source config form validates with these schemas in the browser).
import type { Env } from "@/lib/env";
import { LIMITS, type SourceType } from "@/lib/types";

import type { ConnectorNeed } from "./types";

const text = (max: number = LIMITS.oneLine) => z.string().trim().min(1).max(max);
const urlText = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), "Use an address that starts with http:// or https://.");
const list = (max: number = LIMITS.name) => z.array(z.string().trim().min(1).max(max)).max(LIMITS.listEntries);

// --- x_user ---------------------------------------------------------------
export const xUserConfigSchema = z.object({
  /** The handle without "@". */
  username: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@+/, ""))
    .pipe(z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "Use an X user name (letters, digits, and _; at most 15).")),
  includeReposts: z.boolean().default(false),
});
export type XUserConfig = z.infer<typeof xUserConfigSchema>;

// --- x_search -------------------------------------------------------------
export const xSearchConfigSchema = z.object({
  query: text(),
  lang: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}$/, "Use a language code, for example en.")
    .default("en"),
  minLikes: z.number().int().min(0).max(1_000_000).default(10),
  /** The API minimum is 10. */
  maxPostsPerRun: z.number().int().min(10).max(100).default(20),
  keepTop: z.number().int().min(1).max(20).default(3),
});
export type XSearchConfig = z.infer<typeof xSearchConfigSchema>;

// --- podcast ----------------------------------------------------------------
export const podcastConfigSchema = z.object({
  feedUrl: urlText,
  show: text(),
  itunesId: z.number().int().positive().optional(),
  transcripts: z.boolean().default(true),
});
export type PodcastConfig = z.infer<typeof podcastConfigSchema>;

// --- blog -------------------------------------------------------------------
export const blogConfigSchema = z.object({
  feedUrl: urlText,
  siteUrl: urlText.optional(),
  /** Entry categories to take (empty = all; no case difference). */
  sections: list().default([]),
  /** Entry authors to take (empty = all; no case difference). */
  authors: list().default([]),
  fullText: z.boolean().default(false),
});
export type BlogConfig = z.infer<typeof blogConfigSchema>;

// --- github -----------------------------------------------------------------
const githubName = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/, `Use the ${what} name as GitHub shows it.`);
export const githubConfigSchema = z.object({
  owner: githubName("owner"),
  repo: githubName("repository"),
  releases: z.boolean().default(true),
  prereleases: z.boolean().default(false),
  discussions: z.boolean().default(false),
  discussionCategories: list().default([]),
  advisories: z.boolean().default(false),
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;

// --- docs -------------------------------------------------------------------
export const docsConfigSchema = z.object({
  url: urlText,
  mode: z.enum(["auto", "changelog", "page"]).default("auto"),
  /** A CSS selector for the main content. */
  selector: z.string().trim().min(1).max(LIMITS.oneLine).optional(),
  ignoreMinorEdits: z.boolean().default(true),
});
export type DocsConfig = z.infer<typeof docsConfigSchema>;

// --- newsletter -------------------------------------------------------------
export const newsletterConfigSchema = z.discriminatedUnion("variant", [
  z.object({ variant: z.literal("feed"), feedUrl: urlText }),
  z.object({
    variant: z.literal("inbox"),
    /** The sender address, for example news@example.com. */
    sender: z
      .string()
      .trim()
      .max(254)
      .regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, "Use a sender address, for example news@example.com."),
    subjectIncludes: z.string().trim().min(1).max(LIMITS.oneLine).optional(),
  }),
]);
export type NewsletterConfig = z.infer<typeof newsletterConfigSchema>;

// --- youtube ----------------------------------------------------------------
export const youtubeConfigSchema = z.discriminatedUnion("variant", [
  z.object({
    variant: z.literal("channel"),
    channelId: z.string().trim().regex(/^UC[A-Za-z0-9_-]{10,40}$/, "Use a channel id that starts with UC."),
    title: text(),
    includeShorts: z.boolean().default(false),
  }),
  z.object({
    variant: z.literal("playlist"),
    playlistId: z.string().trim().regex(/^[A-Za-z0-9_-]{10,64}$/, "Use a playlist id."),
    title: text(),
  }),
]);
export type YoutubeConfig = z.infer<typeof youtubeConfigSchema>;

// --- community --------------------------------------------------------------
export const communityConfigSchema = z.discriminatedUnion("variant", [
  z.object({
    variant: z.literal("hn"),
    /** null = the front page. */
    query: z.string().trim().min(1).max(LIMITS.oneLine).nullable().default(null),
    minPoints: z.number().int().min(0).max(100_000).default(50),
    minComments: z.number().int().min(0).max(100_000).default(0),
  }),
  z.object({
    variant: z.literal("reddit"),
    /** The name without "r/". */
    subreddit: z
      .string()
      .trim()
      .transform((value) => value.replace(/^\/?r\//i, ""))
      .pipe(z.string().regex(/^[A-Za-z0-9_]{2,21}$/, "Use a subreddit name, for example LocalLLaMA.")),
    listing: z.enum(["top_day", "hot", "new"]).default("top_day"),
    minScore: z.number().int().min(0).max(1_000_000).default(50),
  }),
  z.object({
    variant: z.literal("discourse"),
    baseUrl: urlText,
    categorySlug: z.string().trim().min(1).max(LIMITS.name).optional(),
    categoryId: z.number().int().positive().optional(),
    tag: z.string().trim().min(1).max(LIMITS.name).optional(),
  }),
]);
export type CommunityConfig = z.infer<typeof communityConfigSchema>;

// --- research ---------------------------------------------------------------
export const researchConfigSchema = z.discriminatedUnion("variant", [
  z.object({
    variant: z.literal("arxiv_query"),
    query: text(),
    /** arXiv categories, for example cs.AI. */
    categories: list(40).default([]),
  }),
  z.object({ variant: z.literal("arxiv_author"), author: text(LIMITS.name) }),
  z.object({
    variant: z.literal("openalex_institution"),
    /** The OpenAlex id, for example I63966007. */
    institutionId: z.string().trim().regex(/^[Ii]\d{1,15}$/, "Use an OpenAlex institution id, for example I63966007."),
    name: text(),
  }),
]);
export type ResearchConfig = z.infer<typeof researchConfigSchema>;

// --- web_search ---------------------------------------------------------------
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Use a domain name, for example example.com.");
export const webSearchConfigSchema = z.object({
  query: text(),
  allowedDomains: z.array(domain).max(LIMITS.listEntries).default([]),
  excludedDomains: z.array(domain).max(LIMITS.listEntries).default([]),
  maxResults: z.number().int().min(1).max(10).default(8),
});
export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

// --- all types ----------------------------------------------------------------

export interface SourceConfigMap {
  x_user: XUserConfig;
  x_search: XSearchConfig;
  podcast: PodcastConfig;
  blog: BlogConfig;
  github: GithubConfig;
  docs: DocsConfig;
  newsletter: NewsletterConfig;
  youtube: YoutubeConfig;
  community: CommunityConfig;
  research: ResearchConfig;
  web_search: WebSearchConfig;
}

export type SourceConfig = SourceConfigMap[SourceType];

export const configSchemas: { [T in SourceType]: z.ZodType<SourceConfigMap[T]> } = {
  x_user: xUserConfigSchema,
  x_search: xSearchConfigSchema,
  podcast: podcastConfigSchema,
  blog: blogConfigSchema,
  github: githubConfigSchema,
  docs: docsConfigSchema,
  newsletter: newsletterConfigSchema,
  youtube: youtubeConfigSchema,
  community: communityConfigSchema,
  research: researchConfigSchema,
  web_search: webSearchConfigSchema,
};

/** Parses a config of unknown origin with the schema of its type (defaults applied). Throws ZodError. */
export function parseConfig<T extends SourceType>(type: T, config: unknown): SourceConfigMap[T] {
  return configSchemas[type].parse(config);
}

/**
 * The fields of each config that the identity uses. The source page shows
 * them read-only (§4.6): add a new source for a different identity.
 */
export const IDENTITY_FIELDS: Record<SourceType, readonly string[]> = {
  x_user: ["username"],
  x_search: ["query", "lang"],
  podcast: ["feedUrl"],
  blog: ["feedUrl"],
  github: ["owner", "repo"],
  docs: ["url"],
  newsletter: ["variant", "feedUrl", "sender", "subjectIncludes"],
  youtube: ["variant", "channelId", "playlistId"],
  community: ["variant", "query", "minPoints", "subreddit", "listing", "baseUrl", "categorySlug", "tag"],
  research: ["variant", "query", "categories", "author", "institutionId"],
  web_search: ["query", "allowedDomains"],
};

/** Lower-case scheme and host, no fragment, no trailing slash. */
function normalizeUrl(input: string): string {
  const raw = input.trim();
  try {
    const url = new URL(raw);
    url.hash = "";
    // URL already gives the scheme and the host in lower case.
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

const lower = (value: string) => value.trim().toLowerCase();
const singleSpaces = (value: string) => value.trim().replace(/\s+/g, " ");
const sortedList = (values: string[]) => [...new Set(values.map(lower))].sort().join(",");

/**
 * The canonical identity of a source: the value of `sources.key`.
 * `config` must be a parsed config of the type (see parseConfig).
 */
export function sourceKey<T extends SourceType>(type: T, config: SourceConfigMap[T]): string;
export function sourceKey(type: SourceType, config: SourceConfig): string {
  switch (type) {
    case "x_user": {
      const c = config as XUserConfig;
      return `x_user:${lower(c.username).replace(/^@+/, "")}`;
    }
    case "x_search": {
      const c = config as XSearchConfig;
      return `x_search:${singleSpaces(c.query).toLowerCase()}|${lower(c.lang)}`;
    }
    case "podcast":
      return `podcast:${normalizeUrl((config as PodcastConfig).feedUrl)}`;
    case "blog":
      return `blog:${normalizeUrl((config as BlogConfig).feedUrl)}`;
    case "github": {
      const c = config as GithubConfig;
      return `github:${lower(c.owner)}/${lower(c.repo)}`;
    }
    case "docs":
      return `docs:${normalizeUrl((config as DocsConfig).url)}`;
    case "newsletter": {
      const c = config as NewsletterConfig;
      if (c.variant === "feed") return `newsletter:feed:${normalizeUrl(c.feedUrl)}`;
      return `newsletter:inbox:${lower(c.sender)}|${c.subjectIncludes ?? ""}`;
    }
    case "youtube": {
      const c = config as YoutubeConfig;
      if (c.variant === "channel") return `youtube:channel:${c.channelId}`;
      return `youtube:playlist:${c.playlistId}`;
    }
    case "community": {
      const c = config as CommunityConfig;
      if (c.variant === "hn") return `community:hn:${c.query ? lower(c.query) : "front_page"}|${c.minPoints}`;
      if (c.variant === "reddit") return `community:reddit:${lower(c.subreddit)}|${c.listing}`;
      return `community:discourse:${normalizeUrl(c.baseUrl)}|${c.categorySlug ?? ""}|${c.tag ?? ""}`;
    }
    case "research": {
      const c = config as ResearchConfig;
      if (c.variant === "arxiv_query") return `research:arxiv_query:${lower(c.query)}|${sortedList(c.categories)}`;
      if (c.variant === "arxiv_author") return `research:arxiv_author:${lower(c.author)}`;
      return `research:openalex:${c.institutionId}`;
    }
    case "web_search": {
      const c = config as WebSearchConfig;
      return `web_search:${lower(c.query)}|${sortedList(c.allowedDomains)}`;
    }
    default: {
      const never: never = type;
      throw new Error(`unknown source type: ${String(never)}`);
    }
  }
}

/**
 * The missing credential or setup of a source type, or null when it is ready
 * (the rule behind Connector.needs, §10.2):
 * x_user and x_search need X_BEARER_TOKEN; the newsletter inbox variant needs
 * the IMAP settings; web_search needs OLLAMA_API_KEY.
 */
export function credentialNeeds(type: SourceType, env: Env, config?: unknown): ConnectorNeed | null {
  switch (type) {
    case "x_user":
    case "x_search":
      return env.has("X_BEARER_TOKEN")
        ? null
        : { code: "x_token", message: "Needs an X API token. Save the X bearer token in Settings → API keys (or set X_BEARER_TOKEN in .env)." };
    case "newsletter": {
      const variant = (config as { variant?: unknown } | undefined)?.variant;
      const mailboxReady = env.has("IMAP_HOST") && env.has("IMAP_USER") && env.has("IMAP_PASSWORD");
      if (variant !== "inbox" || mailboxReady) return null;
      return {
        code: "mailbox",
        message:
          "Needs the newsletter mailbox. Add IMAP_HOST, IMAP_USER, and IMAP_PASSWORD (optional: IMAP_PORT, IMAP_MAILBOX) to the .env file and start the app again.",
      };
    }
    case "web_search":
      return env.has("OLLAMA_API_KEY")
        ? null
        : { code: "model_key", message: "Needs the model key. Save the Ollama API key in Settings → API keys (or set OLLAMA_API_KEY in .env)." };
    default:
      return null;
  }
}
