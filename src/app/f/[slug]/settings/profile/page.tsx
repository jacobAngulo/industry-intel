import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getActor } from "@/app/_lib/identity";
import { FeedProfileForm } from "@/components/settings/FeedProfileForm";
import { GroupHeader } from "@/components/settings/GroupHeader";
import { RejudgeProgressLine } from "@/components/settings/RejudgeProgressLine";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { TeamProfileForm } from "@/components/settings/TeamProfileForm";
import { getFeedBySlug, getTeamProfile, rejudgeProgress } from "@/lib/services";

export async function generateMetadata({ params }: PageProps<"/f/[slug]/settings/profile">): Promise<Metadata> {
  const feed = await getFeedBySlug((await params).slug);
  return { title: feed ? `Feed Profile · ${feed.name} settings` : "Feed settings" };
}

/** §4.8 Feed Profile: this feed (name, purpose, context) and the shared feed profile. */
export default async function FeedProfileSettingsPage({ params }: PageProps<"/f/[slug]/settings/profile">) {
  const { slug } = await params;
  const feed = await getFeedBySlug(slug);
  if (!feed || feed.archived) notFound();
  const [profile, actor, progress] = await Promise.all([getTeamProfile(), getActor(), rejudgeProgress(feed.id)]);
  const progressOpen = progress?.status === "queued" || progress?.status === "running";

  return (
    <section aria-labelledby="settings-group-title" className="flex flex-col gap-8">
      <GroupHeader
        title="Feed Profile"
        description="This profile tells the model what this feed follows and why. A change applies to new stories."
      />
      <SettingsSection
        id="this-feed"
        as="h2"
        title="This feed"
        description="The model reads the purpose and the context for each new story of this feed."
      >
        <FeedProfileForm
          feedId={feed.id}
          initial={{ name: feed.name, purpose: feed.purpose, projectContext: feed.projectContext }}
          name={actor.name}
        />
      </SettingsSection>
      <SettingsSection
        id="shared-feed-profile"
        as="h2"
        title="Shared feed profile"
        description={
          <>
            Context that every feed uses. A change applies to new stories in every feed. You can also edit it in the{" "}
            <Link href="/settings#shared-feed-profile">shared settings</Link>.
          </>
        }
      >
        <TeamProfileForm profile={profile} name={actor.name} />
      </SettingsSection>
      {progress && !progressOpen ? (
        <div className="border-t border-border pt-4">
          <RejudgeProgressLine progress={progress} />
        </div>
      ) : null}
    </section>
  );
}
