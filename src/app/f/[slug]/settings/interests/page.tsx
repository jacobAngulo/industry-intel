import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getActor } from "@/app/_lib/identity";
import { GroupHeader } from "@/components/settings/GroupHeader";
import { InterestsForm } from "@/components/settings/InterestsForm";
import { getFeedBySlug, listTopics } from "@/lib/services";
import type { TopicPriority } from "@/lib/types";

export async function generateMetadata({ params }: PageProps<"/f/[slug]/settings/interests">): Promise<Metadata> {
  const feed = await getFeedBySlug((await params).slug);
  return { title: feed ? `Interests · ${feed.name} settings` : "Feed settings" };
}

/** §4.8 Interests: topic priorities, exclusions, relevance priorities, minimum relevance, freshness. */
export default async function FeedInterestsSettingsPage({ params }: PageProps<"/f/[slug]/settings/interests">) {
  const { slug } = await params;
  const feed = await getFeedBySlug(slug);
  if (!feed || feed.archived) notFound();
  const [topics, actor] = await Promise.all([listTopics(), getActor()]);
  const topicPriorities: Record<string, TopicPriority> = Object.fromEntries(
    Object.entries(feed.topicPriorities).map(([id, priority]) => [String(id), priority]),
  );

  return (
    <section aria-labelledby="settings-group-title" className="flex flex-col gap-8">
      <GroupHeader
        title="Interests"
        description="What this feed cares about, what it never wants, and how strict it is."
      />
      <InterestsForm
        feedId={feed.id}
        topics={topics.map((t) => ({ id: t.id, name: t.name, description: t.description }))}
        initial={{
          topicPriorities,
          exclusions: feed.exclusions,
          relevancePriorities: feed.relevancePriorities,
          minRelevance: feed.minRelevance,
          halfLifeHours: feed.halfLifeHours,
        }}
        name={actor.name}
      />
    </section>
  );
}
