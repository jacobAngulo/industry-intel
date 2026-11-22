import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/app/_lib/identity";
import { formatPeriod } from "@/components/feed/digest-format";
import { MarkDigestsSeen } from "@/components/feed/DigestsSeen";
import { loadActiveFeed } from "@/components/feed/load-feed";
import { countLabel } from "@/components/story/format";
import { EmptyState, LinkButton } from "@/components/ui";
import { listDigests, type FeedDetail } from "@/lib/services";
import { nowMs } from "@/lib/time";
import { DIGEST_FREQUENCY_LABELS, WEEKDAY_LABELS } from "@/lib/types";

export async function generateMetadata({ params }: PageProps<"/f/[slug]/digests">): Promise<Metadata> {
  const { slug } = await params;
  const feed = await loadActiveFeed(slug);
  return feed ? { title: `Digests · ${feed.name}` } : {};
}

/** "Weekdays at 08:30 (Europe/Berlin), at most 10 stories", or null when digests are off. */
function scheduleText(feed: FeedDetail): string | null {
  const d = feed.digest;
  if (d.frequency === "off") return null;
  const when =
    d.frequency === "weekly" ? `Each ${WEEKDAY_LABELS[d.weekday] ?? "week"}` : DIGEST_FREQUENCY_LABELS[d.frequency];
  return `${when} at ${d.time} (${d.timeZone}), at most ${countLabel(d.maxStories, "story", "stories")}.`;
}

/** The digest list of a feed (§4.4): newest first, rows with entries only. */
export default async function DigestsPage({ params }: PageProps<"/f/[slug]/digests">) {
  await requireUser();
  const { slug } = await params;
  const feed = await loadActiveFeed(slug);
  if (!feed) notFound();
  const digests = await listDigests(feed.id);
  const schedule = scheduleText(feed);
  const base = `/f/${encodeURIComponent(feed.slug)}`;

  return (
    <div className="flex flex-col gap-5">
      <MarkDigestsSeen feedId={feed.id} at={nowMs()} />
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-semibold text-fg">Digests</h1>
        <p className="text-sm text-muted">
          {schedule ? `A snapshot of the top stories of each period. Schedule: ${schedule}` : "Digests are off for this feed."}{" "}
          <Link href={`${base}/settings/delivery`} className="text-accent">
            Change the schedule
          </Link>
        </p>
      </div>
      {digests.length === 0 ? (
        <EmptyState
          icon="newspaper"
          title="No digests yet"
          description={
            <p>
              {schedule
                ? "A digest shows here after its first scheduled time, when the period has stories."
                : "Turn on the digest in the delivery settings of this feed."}
            </p>
          }
          actions={
            <LinkButton href={base} variant="secondary">
              Go to the stories
            </LinkButton>
          }
        />
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {digests.map((d) => (
            <li key={d.id} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <Link href={`${base}/digests/${d.id}`} className="font-medium text-fg">
                  {d.title}
                </Link>
                <p className="text-sm text-muted">{formatPeriod(d.periodStart, d.periodEnd, feed.digest.timeZone)}</p>
              </div>
              <p className="shrink-0 text-sm text-muted tabular-nums">{countLabel(d.entryCount, "story", "stories")}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
