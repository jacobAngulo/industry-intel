import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireUser } from "@/app/_lib/identity";
import { DeliveryForm } from "@/components/settings/DeliveryForm";
import { GroupHeader } from "@/components/settings/GroupHeader";
import { supportedTimeZones, timeZoneOptions } from "@/components/settings/helpers";
import { getDefaults, getFeedBySlug } from "@/lib/services";

export async function generateMetadata({ params }: PageProps<"/f/[slug]/settings/delivery">): Promise<Metadata> {
  const feed = await getFeedBySlug((await params).slug);
  return { title: feed ? `Delivery · ${feed.name} settings` : "Feed settings" };
}

/** §4.8 Delivery: brief format, digest schedule, quiet hours, alert rule; archive the feed. */
export default async function FeedDeliverySettingsPage({ params }: PageProps<"/f/[slug]/settings/delivery">) {
  const { slug } = await params;
  const feed = await getFeedBySlug(slug);
  if (!feed || feed.archived) notFound();
  const [defaults] = await Promise.all([getDefaults(), requireUser()]);

  return (
    <section aria-labelledby="settings-group-title" className="flex flex-col gap-8">
      <GroupHeader
        title="Delivery"
        description="How the stories of this feed read, when the digest comes, and what deserves an alert. Delivery is in the app only."
      />
      <DeliveryForm
        feedId={feed.id}
        feedName={feed.name}
        initial={{ briefFormat: feed.briefFormat, digest: feed.digest, quietHours: feed.quietHours, alerts: feed.alerts }}
        briefDefaults={defaults.briefDefaults}
        timeZones={timeZoneOptions(feed.digest.timeZone, supportedTimeZones())}
      />
    </section>
  );
}
