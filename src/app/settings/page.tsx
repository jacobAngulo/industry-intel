import type { Metadata } from "next";

import { requireUser } from "@/app/_lib/identity";
import { ArchivedFeeds } from "@/components/settings/ArchivedFeeds";
import { DefaultsForm } from "@/components/settings/DefaultsForm";
import { KeysForm, type KeyRowData } from "@/components/settings/KeysForm";
import { supportedTimeZones, timeZoneOptions } from "@/components/settings/helpers";
import { RejudgeProgressLine } from "@/components/settings/RejudgeProgressLine";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { TeamProfileForm } from "@/components/settings/TeamProfileForm";
import { TopicsManager } from "@/components/settings/TopicsManager";
import { PageContainer, PageHeader } from "@/components/ui";
import { getDefaults, getKeyStatuses, getTeamProfile, listFeeds, listTopics, rejudgeProgress } from "@/lib/services";

export const metadata: Metadata = { title: "Shared settings" };

const KEY_HINTS: Record<KeyRowData["name"], string> = {
  OLLAMA_API_KEY: "The model judges and analyses stories, and runs the web search sources. Get a key at ollama.com.",
  X_BEARER_TOKEN: "X user and X keyword sources read posts with it (paid X API quota).",
};

const SECTIONS = [
  { id: "shared-feed-profile", label: "Shared feed profile" },
  { id: "topics", label: "Topics" },
  { id: "defaults", label: "Defaults" },
  { id: "api-keys", label: "API keys" },
  { id: "archived-feeds", label: "Archived feeds" },
];

/** §4.9 Shared settings: shared feed profile, topics, defaults, API keys, archived feeds. */
export default async function SharedSettingsPage() {
  const [profile, topics, defaults, feeds, actor, keyStatuses] = await Promise.all([
    getTeamProfile(),
    listTopics({ includeArchived: true }),
    getDefaults(),
    listFeeds({ includeArchived: true }),
    requireUser(),
    getKeyStatuses(),
  ]);
  const keys: KeyRowData[] = keyStatuses.map((k) => ({ ...k, hint: KEY_HINTS[k.name] }));
  const active = feeds.filter((f) => !f.archived);
  const archived = feeds.filter((f) => f.archived);
  const progress = await Promise.all(active.map(async (f) => ({ feed: f, progress: await rejudgeProgress(f.id) })));
  const running = progress.filter(
    (p) => p.progress && (p.progress.status === "queued" || p.progress.status === "running"),
  );

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Shared settings"
        description="These settings apply to every feed. Each feed has its own settings in its Settings tab."
      />
      <nav aria-label="Sections of this page" className="mb-6">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-muted hover:text-fg">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex flex-col gap-10">
        <SettingsSection
          id="shared-feed-profile"
          title="Shared feed profile"
          description="Context that every feed uses. The model reads it for each new story, so a change applies to new stories in every feed."
        >
          <TeamProfileForm profile={profile} id="shared-team" />
          {running.length > 0 ? (
            <div className="mt-4 flex flex-col gap-1">
              {running.map((p) => (
                <RejudgeProgressLine key={p.feed.id} progress={p.progress} feedName={p.feed.name} />
              ))}
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection
          id="topics"
          title="Topics"
          description="Topics and watchlists that every feed can use. Each feed sets its own priority for each topic in its Interests settings."
        >
          <TopicsManager
            topics={topics.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name, description: t.description }))}
            archivedNames={topics.filter((t) => t.archived).map((t) => t.name)}
          />
        </SettingsSection>

        <SettingsSection id="defaults" title="Defaults">
          <DefaultsForm
            initial={defaults}
            timeZones={timeZoneOptions(defaults.feedDefaults.digest.timeZone, supportedTimeZones())}
          />
        </SettingsSection>

        <SettingsSection
          id="api-keys"
          title="API keys"
          description="A key saved here replaces the same variable in .env, and the app uses it at the next call: no restart. The page never shows a saved key."
        >
          {actor.isAdmin ? <KeysForm keys={keys} /> : <p className="text-sm text-muted">Only an administrator can change the keys.</p>}
        </SettingsSection>

        <SettingsSection
          id="archived-feeds"
          title="Archived feeds"
          description="An archived feed is not in the tabs and gets no new judgements."
        >
          <ArchivedFeeds feeds={archived.map((f) => ({ id: f.id, name: f.name, purpose: f.purpose }))} canDelete={actor.isAdmin} />
        </SettingsSection>
      </div>
    </PageContainer>
  );
}
