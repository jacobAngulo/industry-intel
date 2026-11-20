// The connector contract of specification §6.2.
import type { z } from "zod";

import type { Env } from "@/lib/env";
import type { SafeHttp } from "@/lib/http/types";
import type { WebSearchProvider } from "@/lib/llm/types";
import type { ItemKind, SourceType, UsageMetric } from "@/lib/types";

export type { UsageMetric } from "@/lib/types";

export interface RawItem {
  /** Stable in the source. */
  externalId: string;
  url?: string;
  title: string;
  author?: string;
  /** Epoch ms. */
  publishedAt?: number;
  kind: ItemKind;
  /** Plain text, no HTML, at most 20 000 characters. */
  text: string;
  /** Absolute http(s) URLs found in the content (max 10). */
  links?: string[];
  meta?: Record<string, unknown>;
  /** Store the item but never judge it (web_search first run). */
  skip?: "baseline";
}

/** The maximum length of RawItem.text. */
export const RAW_ITEM_MAX_TEXT = 20_000;
/** The maximum number of RawItem.links. */
export const RAW_ITEM_MAX_LINKS = 10;

export interface Candidate {
  type: SourceType;
  name: string;
  /** One line for the candidate card. */
  description: string;
  /** Human link to the origin. */
  url?: string;
  /** Valid for the configSchema of the type. */
  config: unknown;
  /** 0..1, to order candidates. */
  confidence: number;
  warnings?: string[];
}

export interface UsageMeter {
  /** Atomic: adds n when the daily limit allows it and returns true; else returns false and adds nothing. */
  take(metric: UsageMetric, n: number): boolean;
  /** No limit check (token counts). */
  add(metric: UsageMetric, n: number): void;
  /** Infinity when the metric has no limit. */
  remaining(metric: UsageMetric): number;
  today(metric: UsageMetric): number;
}
// Limits: llm_calls -> LLM_MAX_CALLS_PER_DAY (1500); llm_calls_preview -> 100; x_posts -> X_MAX_POSTS_PER_DAY (300);
// web_searches -> WEB_SEARCH_MAX_PER_DAY (50); all others: no limit. The day is the UTC day.

export interface MailReader {
  list(q: { from: string; subjectIncludes?: string; sinceUid: number | null; limit: number }): Promise<{
    uidValidity: number;
    messages: Array<{
      uid: number;
      messageId: string;
      from: string;
      subject: string;
      date: number;
      text: string;
      html?: string;
    }>;
  }>;
}

export interface ConnectorContext {
  /** §11.1. Connectors make NO network call except through ctx.http (and ctx.mail). */
  http: SafeHttp;
  /** Typed access to environment values (never logged). */
  env: Env;
  now: () => number;
  usage: UsageMeter;
  /** For web_search; null with no model key. */
  search: WebSearchProvider | null;
  /** For the newsletter inbox variant; null when the mailbox is not set. */
  mail: MailReader | null;
  signal?: AbortSignal;
}

export interface FetchResult<S> {
  /** Newest first. */
  items: RawItem[];
  /** Stored in sources.cursor after a successful poll; ignored in preview mode. */
  cursor: S | null;
}

export type ConnectorErrorKind =
  | "needs_credentials"
  | "not_found"
  | "rate_limited"
  | "blocked"
  | "bad_response"
  | "network"
  | "budget";

export class ConnectorError extends Error {
  kind: ConnectorErrorKind;

  /** `message` must be fit to show in the UI. */
  constructor(kind: ConnectorErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectorError";
    this.kind = kind;
  }
}

export type ConnectorNeed = { code: "x_token" | "mailbox" | "model_key"; message: string };

export interface Connector<C = unknown, S = unknown> {
  type: SourceType;
  label: string;
  description: string;
  defaultIntervalMinutes: number;
  maxAgeDays: number;
  configSchema: z.ZodType<C>;
  /** Missing credential or setup, or null when ready. */
  needs(env: Env, config?: C): ConnectorNeed | null;
  /** Canonical identity for sources.key. */
  keyOf(config: C): string;
  /**
   * Turn one entry that a person typed into candidates. Cheap pattern checks first; keyless lookups allowed;
   * never a paid call. Return [] when the input is not for this type. `forced` = the person chose this type.
   */
  resolve(input: string, ctx: ConnectorContext, forced: boolean): Promise<Candidate[]>;
  /** mode 'preview': recent items, no cursor effect, small cost bound. mode 'poll': new items since the cursor. */
  fetch(args: {
    config: C;
    cursor: S | null;
    mode: "preview" | "poll";
    limit: number;
    ctx: ConnectorContext;
  }): Promise<FetchResult<S>>;
}
