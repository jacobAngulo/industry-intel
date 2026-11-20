// The `github` connector (specification §6.3): releases from the public Atom feed, security
// advisories from the REST API with no token, and discussions through GraphQL with GITHUB_TOKEN.
import { SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { credentialNeeds, githubConfigSchema, sourceKey, type GithubConfig } from "../configs";
import type { Connector, RawItem } from "../types";
import { fetchAdvisories, type GithubAdvisoriesState } from "./advisories";
import { fetchDiscussions, type GithubDiscussionsState } from "./discussions";
import { fetchReleases, newestFirst, type GithubReleasesState } from "./releases";
import { resolveGithub } from "./resolve";

export { isPrereleaseTag } from "./releases";
export { parseRepoInput, DISCUSSIONS_NEED_TOKEN } from "./resolve";
export type { GithubAdvisoriesState, GithubDiscussionsState, GithubReleasesState };

/** The cursor of a github source: one sub-state for each event type. */
export interface GithubCursor {
  releases?: GithubReleasesState;
  advisories?: GithubAdvisoriesState;
  discussions?: GithubDiscussionsState;
}

/** Items of a preview: few, and each event type costs one request. */
const PREVIEW_MAX_ITEMS = 10;
const PREVIEW_ADVISORIES = 5;

export const connector: Connector<GithubConfig, GithubCursor> = {
  type: "github",
  label: SOURCE_TYPE_LABELS.github,
  description: "Releases of a repository, and optionally its discussions and security advisories.",
  defaultIntervalMinutes: SOURCE_TYPE_DEFAULTS.github.intervalMinutes,
  maxAgeDays: SOURCE_TYPE_DEFAULTS.github.maxAgeDays,
  configSchema: githubConfigSchema,
  needs: (env, config) => credentialNeeds("github", env, config),
  keyOf: (config) => sourceKey("github", config),

  resolve(input, ctx, forced) {
    return resolveGithub(input, ctx, forced);
  },

  async fetch({ config, cursor, mode, limit, ctx }) {
    const preview = mode === "preview";
    const previous: GithubCursor = preview ? {} : (cursor ?? {});
    const conditional = !preview && cursor !== null;
    // A type that is switched off keeps its sub-state, so that switching it on again does not
    // bring back what the source saw before.
    const next: GithubCursor = { ...previous };
    const items: RawItem[] = [];

    if (config.releases) {
      const result = await fetchReleases({ config, state: previous.releases, conditional, ctx });
      items.push(...result.items);
      next.releases = result.state;
    }
    if (config.advisories) {
      const perPage = preview ? PREVIEW_ADVISORIES : Math.min(100, Math.max(10, limit));
      const result = await fetchAdvisories({ config, state: previous.advisories, conditional, perPage, ctx });
      items.push(...result.items);
      next.advisories = result.state;
    }
    const token = ctx.env.githubToken;
    if (config.discussions && token) {
      const first = preview ? PREVIEW_MAX_ITEMS : Math.min(50, Math.max(10, limit));
      const result = await fetchDiscussions({ config, state: previous.discussions, conditional, first, token, ctx });
      items.push(...result.items);
      next.discussions = result.state;
    }

    const max = Math.max(0, preview ? Math.min(limit, PREVIEW_MAX_ITEMS) : limit);
    return { items: newestFirst(items).slice(0, max), cursor: preview ? null : next };
  },
};
