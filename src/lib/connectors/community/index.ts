// The `community` connector (specification §6.3): Hacker News (Algolia API),
// a subreddit (the .json listing, or OAuth with REDDIT_CLIENT_ID /
// REDDIT_CLIENT_SECRET), or a Discourse forum (the .json endpoints).
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, sourceKey, communityConfigSchema, type CommunityConfig } from "../configs";
import type { Candidate, Connector } from "../types";
import { fetchDiscourse, resolveDiscourseUrl } from "./discourse";
import { fetchHn, hnTextCandidate, resolveHnText, resolveHnUrl } from "./hn";
import { fetchReddit, redditGuess, resolveRedditText, resolveRedditUrl } from "./reddit";
import { parseInputUrl, type CommunityCursor } from "./shared";

export type { CommunityCursor } from "./shared";

/** Hosts of other source types: a link to them is never a forum. */
const OTHER_TYPE_HOSTS =
  /(^|\.)(x\.com|twitter\.com|github\.com|youtube\.com|youtu\.be|arxiv\.org|openalex\.org|apple\.com|spotify\.com|substack\.com|medium\.com|google\.com|linkedin\.com)$/i;

/** Plain text that can be a topic: not a link, not an address, not an @handle. */
function isTopicText(text: string): boolean {
  if (text.length < 2 || text.length > 300) return false;
  if (/^@\S+$/.test(text)) return false;
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

export const connector: Connector<CommunityConfig, CommunityCursor> = {
  type: "community",
  label: SOURCE_TYPE_LABELS.community,
  description: "Discussions from Hacker News, a subreddit, or a Discourse forum.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.community.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.community.maxAgeDays,
  configSchema: communityConfigSchema,
  needs: (env, config) => credentialNeeds("community", env, config),
  keyOf: (config) => sourceKey("community", config),

  async resolve(input, ctx, forced): Promise<Candidate[]> {
    const text = typeof input === "string" ? input.trim() : "";
    if (text === "") return [];
    const hasRedditCredentials = ctx.env.has("REDDIT_CLIENT_ID") && ctx.env.has("REDDIT_CLIENT_SECRET");

    // Cheap pattern checks first.
    const prefixed = resolveHnText(text) ?? resolveRedditText(text, hasRedditCredentials);
    if (prefixed) return prefixed;

    const url = parseInputUrl(text);
    if (url) {
      const hn = resolveHnUrl(url);
      if (hn) return hn;
      const reddit = resolveRedditUrl(url, hasRedditCredentials);
      if (reddit) return reddit;
      if (OTHER_TYPE_HOSTS.test(url.hostname)) return [];
      // One request: is it a Discourse forum?
      return resolveDiscourseUrl(url, ctx, forced);
    }

    if (!isTopicText(text)) return [];
    const candidates: Candidate[] = [hnTextCandidate(text, forced)];
    if (forced) {
      const guess = redditGuess(text, hasRedditCredentials);
      if (guess) candidates.push(guess);
    }
    return candidates;
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    switch (config.variant) {
      case "hn":
        return fetchHn({ config, cursor, mode, limit, ctx, maxAgeDays: SOURCE_TYPE_DEFAULTS.community.maxAgeDays });
      case "reddit":
        return fetchReddit({ config, cursor, mode, limit, ctx });
      case "discourse":
        return fetchDiscourse({ config, cursor, mode, limit, ctx });
    }
  },
};
