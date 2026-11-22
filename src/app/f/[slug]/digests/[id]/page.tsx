import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/app/_lib/identity";
import { cache } from "react";

import { formatPeriod } from "@/components/feed/digest-format";
import { loadActiveFeed } from "@/components/feed/load-feed";
import { ModelText } from "@/components/story/ModelText";
import { BriefLine, ExternalIconLink, storyHref } from "@/components/story/StoryCard";
import { Icon, Meter } from "@/components/ui";
import { getDigest } from "@/lib/services";
import { SUMMARY_SENTENCES } from "@/lib/types";

const loadDigest = cache(async (slug: string, id: string) => {
  const feed = await loadActiveFeed(slug);
  if (!feed || !/^\d{1,15}$/.test(id)) return null;
  const digest = await getDigest(feed.id, Number(id));
  return digest ? { feed, digest } : null;
});

export async function generateMetadata({ params }: PageProps<"/f/[slug]/digests/[id]">): Promise<Metadata> {
  const { slug, id } = await params;
  const loaded = await loadDigest(slug, id);
  return loaded ? { title: loaded.digest.title } : {};
}

/** One digest (§4.4): a snapshot of the top stories of one period, as compact briefs in rank order. */
export default async function DigestPage({ params }: PageProps<"/f/[slug]/digests/[id]">) {
  await requireUser();
  const { slug, id } = await params;
  const loaded = await loadDigest(slug, id);
  if (!loaded) notFound();
  const { feed, digest } = loaded;
  const base = `/f/${encodeURIComponent(feed.slug)}`;
  const sentences = SUMMARY_SENTENCES[feed.effectiveBriefFormat.summaryLength];
  const showActions = feed.effectiveBriefFormat.suggestedActions;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href={`${base}/digests`} className="inline-flex items-center gap-1 self-start text-sm text-muted no-underline hover:text-fg">
          <Icon name="arrowRight" size={14} className="rotate-180" />
          All digests
        </Link>
        <h1 className="font-serif text-[1.75rem] leading-tight font-semibold tracking-tight text-balance text-fg sm:text-[2rem]">
          {digest.title}
        </h1>
        <p className="text-sm text-muted">
          {formatPeriod(digest.periodStart, digest.periodEnd, feed.digest.timeZone)} ·{" "}
          {digest.entries.length === 1 ? "1 story" : `${digest.entries.length} stories`}
        </p>
        <p className="text-sm text-muted">A snapshot: the briefs as they were when the digest was made.</p>
      </div>
      {digest.entries.length === 0 ? (
        <p className="text-muted">This digest has no stories: no visible story of this feed is from this period.</p>
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {digest.entries.map((entry, i) => {
            const summary = Array.isArray(entry.summary) ? entry.summary.slice(0, sentences) : [];
            return (
              <li key={`${entry.storyId}-${i}`} className="flex flex-col gap-2 py-5">
                <h2 className="font-serif text-lg leading-snug font-semibold text-balance text-fg">
                  <span className="mr-2 text-muted tabular-nums">{i + 1}.</span>
                  {entry.storyExists ? (
                    <Link href={storyHref(feed.slug, entry.storyId)} className="text-fg no-underline hover:underline">
                      {entry.headline}
                    </Link>
                  ) : (
                    entry.headline
                  )}
                  {entry.storyExists ? <ExternalIconLink url={entry.primaryUrl} /> : null}
                </h2>
                {!entry.storyExists ? <p className="text-sm text-muted">This story no longer exists in the app.</p> : null}
                <div className="flex flex-col gap-1.5 leading-relaxed">
                  {summary.length > 0 ? (
                    <BriefLine label="What changed">
                      <ModelText text={summary.join(" ")} />
                    </BriefLine>
                  ) : null}
                  {entry.whyItMatters ? (
                    <BriefLine label="Why it matters">
                      <ModelText text={entry.whyItMatters} />
                    </BriefLine>
                  ) : null}
                  {showActions && entry.suggestedAction ? (
                    <BriefLine label="Suggested action">
                      <ModelText text={entry.suggestedAction} />
                    </BriefLine>
                  ) : null}
                </div>
                <Meter value={entry.relevance} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
