import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getActor } from "@/app/_lib/identity";
import { FeedSourcesEditor, type FeedSourceItem } from "@/components/settings/FeedSourcesEditor";
import { GroupHeader } from "@/components/settings/GroupHeader";
import { LinkButton } from "@/components/ui";
import { getFeedBySlug, listFeedSources } from "@/lib/services";

export async function generateMetadata({ params }: PageProps<"/f/[slug]/settings/sources">): Promise<Metadata> {
  const feed = await getFeedBySlug((await params).slug);
  return { title: feed ? `Sources · ${feed.name} settings` : "Feed settings" };
}

/** §4.8 Sources: every source of the directory, with the switch and the filters of this feed. */
export default async function FeedSourcesSettingsPage({ params }: PageProps<"/f/[slug]/settings/sources">) {
  const { slug } = await params;
  const feed = await getFeedBySlug(slug);
  if (!feed || feed.archived) notFound();
  const [rows, actor] = await Promise.all([listFeedSources(feed.id), getActor()]);
  const items: FeedSourceItem[] = rows.map((row) => ({
    id: row.source.id,
    type: row.source.type,
    name: row.source.name,
    status: row.source.status,
    statusDetail: row.source.statusDetail,
    included: row.included,
    priority: row.priority,
    follow: row.follow,
    ignore: row.ignore,
  }));
  const addHref = `/sources/new?feed=${encodeURIComponent(feed.slug)}`;

  return (
    <section aria-labelledby="settings-group-title" className="flex flex-col gap-6">
      <GroupHeader
        title="Sources"
        description="The sources of the shared directory that this feed uses. Follow and Ignore apply only in this feed."
        actions={
          <LinkButton href={addHref} icon="add" size="sm">
            Add a new source
          </LinkButton>
        }
      />
      <FeedSourcesEditor feedId={feed.id} feedName={feed.name} items={items} name={actor.name} addHref={addHref} />
    </section>
  );
}
