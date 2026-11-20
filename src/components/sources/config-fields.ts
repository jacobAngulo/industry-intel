// The fields of the type-specific config form (specification §6.3), one list
// for each source type and variant. The keys match the zod schemas of
// src/lib/connectors/configs.ts (config-fields.test.ts checks it). Pure: no
// React and no Node, so the client form and the tests can import it.
import type { SourceType } from "@/lib/types";

interface FieldBase {
  key: string;
  label: string;
  /** One short line: what the field does for the feed. */
  help: string;
}

export type ConfigField =
  | (FieldBase & {
      kind: "text";
      /** "required": must not be empty; "optional": empty = left out; "nullable": empty = null. */
      empty: "required" | "optional" | "nullable";
      placeholder?: string;
      maxLength: number;
      inputMode?: "url" | "email" | "text";
    })
  | (FieldBase & { kind: "number"; min: number; max: number; optional?: boolean; suffix?: string })
  | (FieldBase & { kind: "boolean" })
  | (FieldBase & { kind: "list"; placeholder?: string; maxLength: number })
  | (FieldBase & { kind: "select"; options: Array<{ value: string; label: string }> });

export type ConfigObject = Record<string, unknown>;

const URL_MAX = 2000;
const ONE_LINE = 300;
const NAME = 120;

/** The variant of a config with variants, or null. */
export function variantOf(config: unknown): string | null {
  if (config && typeof config === "object" && "variant" in config) {
    const variant = (config as { variant?: unknown }).variant;
    return typeof variant === "string" ? variant : null;
  }
  return null;
}

/** The name of a variant, for the line above the form. */
export function variantLabel(type: SourceType, variant: string | null): string | null {
  const labels: Partial<Record<SourceType, Record<string, string>>> = {
    newsletter: { feed: "Publication feed", inbox: "Emails from a sender" },
    youtube: { channel: "Channel", playlist: "Playlist" },
    community: { hn: "Hacker News", reddit: "Reddit", discourse: "Discourse forum" },
    research: { arxiv_query: "arXiv search", arxiv_author: "arXiv author", openalex_institution: "Research lab (OpenAlex)" },
  };
  if (!variant) return null;
  return labels[type]?.[variant] ?? null;
}

/** The form fields of a config. Unknown variants give no field. */
export function configFields(type: SourceType, config: unknown): ConfigField[] {
  const variant = variantOf(config);
  switch (type) {
    case "x_user":
      return [
        { key: "username", kind: "text", empty: "required", maxLength: 16, label: "X user name", help: "The account to follow, without the @.", placeholder: "chamath" },
        { key: "includeReposts", kind: "boolean", label: "Include reposts", help: "Also take posts that this account reposts from others." },
      ];
    case "x_search":
      return [
        { key: "query", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Search words", help: "The X search. Replies and reposts are left out.", placeholder: "coding agents" },
        { key: "lang", kind: "text", empty: "required", maxLength: 3, label: "Language", help: "A language code, for example en." },
        { key: "minLikes", kind: "number", min: 0, max: 1_000_000, label: "Minimum likes", help: "Posts with fewer likes are dropped." },
        { key: "maxPostsPerRun", kind: "number", min: 10, max: 100, label: "Posts read for each run", help: "Each post read costs money at X. The X minimum is 10." },
        { key: "keepTop", kind: "number", min: 1, max: 20, label: "Posts kept for each run", help: "Only the most liked posts of a run go to the model." },
      ];
    case "podcast":
      return [
        { key: "feedUrl", kind: "text", empty: "required", maxLength: URL_MAX, inputMode: "url", label: "Feed address", help: "The RSS feed of the show." },
        { key: "show", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Show name", help: "The name of the show as the feed gives it." },
        { key: "itunesId", kind: "number", min: 1, max: 99_999_999_999, optional: true, label: "Apple Podcasts id", help: "Links the show to Apple Podcasts. You can leave it empty." },
        { key: "transcripts", kind: "boolean", label: "Use transcripts", help: "When an episode has a published transcript, the model reads it instead of the show notes." },
      ];
    case "blog":
      return [
        { key: "feedUrl", kind: "text", empty: "required", maxLength: URL_MAX, inputMode: "url", label: "Feed address", help: "The RSS, Atom, or JSON feed of the blog." },
        { key: "siteUrl", kind: "text", empty: "optional", maxLength: URL_MAX, inputMode: "url", label: "Site address", help: "The home page of the blog, for the link on the source page." },
        { key: "sections", kind: "list", maxLength: NAME, label: "Only these sections", help: "Take only posts in these categories. Empty = all posts.", placeholder: "engineering, ai" },
        { key: "authors", kind: "list", maxLength: NAME, label: "Only these authors", help: "Take only posts by these people. Empty = all authors." },
        { key: "fullText", kind: "boolean", label: "Read the full article", help: "When the feed gives only a short excerpt, the app reads the article page." },
      ];
    case "github":
      return [
        { key: "owner", kind: "text", empty: "required", maxLength: 100, label: "Owner", help: "The user or organization on GitHub.", placeholder: "anthropics" },
        { key: "repo", kind: "text", empty: "required", maxLength: 100, label: "Repository", help: "The repository name.", placeholder: "claude-code" },
        { key: "releases", kind: "boolean", label: "Releases", help: "Each new release becomes an item." },
        { key: "prereleases", kind: "boolean", label: "Pre-releases", help: "Also take betas and release candidates." },
        { key: "advisories", kind: "boolean", label: "Security advisories", help: "Security notices of the repository." },
        { key: "discussions", kind: "boolean", label: "Discussions", help: "Selected discussions. Needs GITHUB_TOKEN on the server." },
        { key: "discussionCategories", kind: "list", maxLength: NAME, label: "Discussion categories", help: "Take only discussions in these categories. Empty = all.", placeholder: "Announcements" },
      ];
    case "docs":
      return [
        { key: "url", kind: "text", empty: "required", maxLength: URL_MAX, inputMode: "url", label: "Page address", help: "The documentation or changelog page to watch." },
        {
          key: "mode",
          kind: "select",
          label: "How to read the page",
          help: "Changelog: each dated entry is an item. Page: new and changed sections are items.",
          options: [
            { value: "auto", label: "Decide on the first check" },
            { value: "changelog", label: "Changelog (dated entries)" },
            { value: "page", label: "Page (watch for changes)" },
          ],
        },
        { key: "selector", kind: "text", empty: "optional", maxLength: ONE_LINE, label: "Main content selector", help: "A CSS selector for the part of the page to watch. Empty = the whole page.", placeholder: "main article" },
        { key: "ignoreMinorEdits", kind: "boolean", label: "Ignore small edits", help: "Small wording changes with no new number do not become items." },
      ];
    case "newsletter":
      if (variant === "feed") {
        return [{ key: "feedUrl", kind: "text", empty: "required", maxLength: URL_MAX, inputMode: "url", label: "Feed address", help: "The RSS feed of the publication." }];
      }
      if (variant === "inbox") {
        return [
          { key: "sender", kind: "text", empty: "required", maxLength: 254, inputMode: "email", label: "Sender address", help: "Emails from this address in the dedicated mailbox become items.", placeholder: "news@example.com" },
          { key: "subjectIncludes", kind: "text", empty: "optional", maxLength: ONE_LINE, label: "Subject contains", help: "Take only emails whose subject has these words. Empty = all." },
        ];
      }
      return [];
    case "youtube":
      if (variant === "channel") {
        return [
          { key: "channelId", kind: "text", empty: "required", maxLength: 42, label: "Channel id", help: "The id that starts with UC." },
          { key: "title", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Channel name", help: "The name of the channel." },
          { key: "includeShorts", kind: "boolean", label: "Include Shorts", help: "Also take short videos." },
        ];
      }
      if (variant === "playlist") {
        return [
          { key: "playlistId", kind: "text", empty: "required", maxLength: 64, label: "Playlist id", help: "The id in the playlist address (list=…)." },
          { key: "title", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Playlist name", help: "The name of the playlist." },
        ];
      }
      return [];
    case "community":
      if (variant === "hn") {
        return [
          { key: "query", kind: "text", empty: "nullable", maxLength: ONE_LINE, label: "Search words", help: "Hacker News stories that match these words. Empty = the front page.", placeholder: "coding agent" },
          { key: "minPoints", kind: "number", min: 0, max: 100_000, label: "Minimum points", help: "Stories with fewer points are dropped." },
          { key: "minComments", kind: "number", min: 0, max: 100_000, label: "Minimum comments", help: "Stories with fewer comments are dropped." },
        ];
      }
      if (variant === "reddit") {
        return [
          { key: "subreddit", kind: "text", empty: "required", maxLength: 24, label: "Subreddit", help: "The name without r/.", placeholder: "LocalLLaMA" },
          {
            key: "listing",
            kind: "select",
            label: "Which posts",
            help: "The list of the subreddit that the app reads.",
            options: [
              { value: "top_day", label: "Top of the day" },
              { value: "hot", label: "Hot" },
              { value: "new", label: "New" },
            ],
          },
          { key: "minScore", kind: "number", min: 0, max: 1_000_000, label: "Minimum score", help: "Posts with a lower score are dropped." },
        ];
      }
      if (variant === "discourse") {
        return [
          { key: "baseUrl", kind: "text", empty: "required", maxLength: URL_MAX, inputMode: "url", label: "Forum address", help: "The home page of the Discourse forum." },
          { key: "categorySlug", kind: "text", empty: "optional", maxLength: NAME, label: "Category", help: "The category name in the address. Empty = all topics." },
          { key: "categoryId", kind: "number", min: 1, max: 999_999_999, optional: true, label: "Category number", help: "The number after the category in the address." },
          { key: "tag", kind: "text", empty: "optional", maxLength: NAME, label: "Tag", help: "Take only topics with this tag. Empty = all." },
        ];
      }
      return [];
    case "research":
      if (variant === "arxiv_query") {
        return [
          { key: "query", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Search words", help: "New arXiv papers that match these words.", placeholder: "agent evaluation" },
          { key: "categories", kind: "list", maxLength: 40, label: "arXiv categories", help: "Take only papers in these categories. Empty = all.", placeholder: "cs.AI, cs.SE" },
        ];
      }
      if (variant === "arxiv_author") {
        return [{ key: "author", kind: "text", empty: "required", maxLength: NAME, label: "Author", help: "New papers by this person on arXiv." }];
      }
      if (variant === "openalex_institution") {
        return [
          { key: "institutionId", kind: "text", empty: "required", maxLength: 16, label: "OpenAlex id", help: "The id of the lab, for example I63966007." },
          { key: "name", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Lab name", help: "The name of the lab or the institution." },
        ];
      }
      return [];
    case "web_search":
      return [
        { key: "query", kind: "text", empty: "required", maxLength: ONE_LINE, label: "Search words", help: "The saved web search.", placeholder: "agent orchestration patterns" },
        { key: "allowedDomains", kind: "list", maxLength: 253, label: "Only these sites", help: "Take only results from these domains. Empty = all sites.", placeholder: "example.com" },
        { key: "excludedDomains", kind: "list", maxLength: 253, label: "Never these sites", help: "Results from these domains are dropped." },
        { key: "maxResults", kind: "number", min: 1, max: 10, label: "Results for each run", help: "Each run costs one web search." },
      ];
    default: {
      const never: never = type;
      return never;
    }
  }
}

/** A list field as text: one entry for each comma or line. */
export function listToText(value: unknown): string {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : "";
}

/** The text of a list field as a list: split on commas and lines, trimmed, no empty entry. */
export function textToList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The new value of a text field. An empty optional field is left out, an empty
 * nullable field is null; a required field keeps the text (the check says what is missing).
 */
export function textFieldValue(field: Extract<ConfigField, { kind: "text" }>, text: string): string | null | undefined {
  if (text.trim() !== "") return text;
  if (field.empty === "optional") return undefined;
  if (field.empty === "nullable") return null;
  return text;
}

/** The new value of a number field: a whole number, undefined for an empty optional field, else the raw text (invalid). */
export function numberFieldValue(field: Extract<ConfigField, { kind: "number" }>, text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === "" && field.optional) return undefined;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return text;
}

/** Sets one key of a config. `undefined` removes the key. */
export function setConfigValue(config: ConfigObject, key: string, value: unknown): ConfigObject {
  const next = { ...config };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * A light check in the browser, for a quick answer before the server check
 * (the server validates with the zod schema of the type). It returns the
 * first problem of each field.
 */
export function checkConfig(type: SourceType, config: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const values = (config ?? {}) as ConfigObject;
  for (const field of configFields(type, config)) {
    const value = values[field.key];
    if (field.kind === "text") {
      const text = typeof value === "string" ? value.trim() : "";
      if (field.empty === "required" && text === "") errors[field.key] = `Enter the ${field.label.toLowerCase()}.`;
      else if (text.length > field.maxLength) errors[field.key] = `Use at most ${field.maxLength} characters.`;
      else if (field.inputMode === "url" && text !== "" && !/^https?:\/\//i.test(text)) {
        errors[field.key] = "Use an address that starts with http:// or https://.";
      }
    } else if (field.kind === "number") {
      if (value === undefined && field.optional) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) {
        errors[field.key] = `Enter a whole number from ${field.min} to ${field.max}.`;
      }
    } else if (field.kind === "list") {
      const list = Array.isArray(value) ? value : [];
      if (list.length > 50) errors[field.key] = "Use at most 50 entries.";
      else if (list.some((entry) => typeof entry === "string" && entry.length > field.maxLength)) {
        errors[field.key] = `Use at most ${field.maxLength} characters for one entry.`;
      }
    }
  }
  return errors;
}
