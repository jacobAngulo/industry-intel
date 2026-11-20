import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";

import { getActor } from "@/app/_lib/identity";
import { Banners } from "@/components/Banners";
import { loadActiveFeed } from "@/components/feed/load-feed";
import { AnalysisSection, MODEL_BANNER_KINDS } from "@/components/story/AnalysisSection";
import { FeedbackButtons } from "@/components/story/FeedbackButtons";
import { DEPTH_LABELS, NOVELTY_LABELS, hiddenReasonText, hostOf, safeHttpUrl } from "@/components/story/format";
import { ModelText } from "@/components/story/ModelText";
import { RankExplanation } from "@/components/story/RankExplanation";
import { BriefLine } from "@/components/story/StoryCard";
import { StoryItems } from "@/components/story/StoryItems";
import { StoryMeta } from "@/components/story/StoryMeta";
import { Banner, Chip, Icon, Meter } from "@/components/ui";
import { getBanners, getStory, type AppBanner } from "@/lib/services";
import { nowMs } from "@/lib/time";

/** The story of this request (generateMetadata and the page both read it). */
const loadStory = cache(async (slug: string, id: string) => {
  const feed = await loadActiveFeed(slug);
  if (!feed || !/^\d{1,15}$/.test(id)) return null;
  const actor = await getActor();
  const detail = await getStory(feed.id, Number(id), actor.clientId);
  return detail ? { feed, detail, actor } : null;
});

export async function generateMetadata({ params }: PageProps<"/f/[slug]/story/[id]">): Promise<Metadata> {
  const { slug, id } = await params;
  const loaded = await loadStory(slug, id);
  return loaded ? { title: `${loaded.detail.card.headline} · ${loaded.feed.name}` } : {};
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-serif text-xl font-semibold text-fg">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm text-muted sm:pt-0.5">{label}</dt>
      <dd className="mb-2 min-w-0 break-words sm:mb-0">{children}</dd>
    </>
  );
}

/** The story page of one feed (§4.2). */
export default async function StoryPage({ params }: PageProps<"/f/[slug]/story/[id]">) {
  const { slug, id } = await params;
  const loaded = await loadStory(slug, id);
  if (!loaded) notFound();
  const { feed, detail, actor } = loaded;
  const { card } = detail;
  const now = nowMs();
  const banners = await getBanners(feed.id);
  const feedHref = `/f/${encodeURIComponent(feed.slug)}`;
  const primary = safeHttpUrl(card.primaryUrl);
  const analysisWaits = detail.analysis?.status === "queued" || detail.analysis?.status === "running";
  // The progress line of a waiting analysis shows the model banners itself.
  const exclude: AppBanner["kind"][] = ["worker_down", "first_run", ...(analysisWaits ? MODEL_BANNER_KINDS : [])];

  return (
    <article aria-labelledby="story-title" className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Link href={feedHref} className="inline-flex items-center gap-1 self-start text-sm text-muted no-underline hover:text-fg">
          <Icon name="arrowRight" size={14} className="rotate-180" />
          Stories of {feed.name}
        </Link>
        <StoryMeta card={card} now={now} />
        <h1 id="story-title" className="font-serif text-[1.75rem] leading-tight font-semibold tracking-tight text-balance break-words text-fg sm:text-[2rem]">
          {card.headline}
        </h1>
        {primary ? (
          <a
            href={primary}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1.5 self-start text-sm text-accent"
          >
            Open the original at {hostOf(primary)}
            <Icon name="external" size={14} />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        {card.hidden ? (
          <Banner tone="info" title="This story is not in the main list of this feed">
            Reason: {hiddenReasonText(card.hidden, card.exclusion)}.
          </Banner>
        ) : null}
        <Banners banners={banners} exclude={exclude} />
        <div className="mt-1 flex flex-col gap-2 text-[1.0625rem] leading-relaxed">
          {card.summary.length > 0 ? (
            <BriefLine label="What changed">
              <ModelText text={card.summary.join(" ")} />
            </BriefLine>
          ) : null}
          {card.whyItMatters ? (
            <BriefLine label="Why it matters">
              <ModelText text={card.whyItMatters} />
            </BriefLine>
          ) : null}
          {card.suggestedAction ? (
            <BriefLine label="Suggested action">
              <ModelText text={card.suggestedAction} />
            </BriefLine>
          ) : null}
        </div>
      </header>

      <Section id="sources-title" title="Sources">
        <StoryItems items={detail.items} feedSlug={feed.slug} storyId={card.storyId} now={now} name={actor.name} />
      </Section>

      <Section id="judgement-title" title="Judgement">
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-[11rem_1fr] sm:gap-y-2">
          <Fact label="Relevance">
            <Meter value={card.relevance} label={null} />
          </Fact>
          <Fact label="Reason">{card.reason ? <ModelText text={card.reason} /> : "No reason given."}</Fact>
          <Fact label="Matched topics">
            {card.topics.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {card.topics.map((t) => (
                  <Chip key={t.id}>{t.name}</Chip>
                ))}
              </span>
            ) : (
              "None"
            )}
          </Fact>
          <Fact label="Novelty">{NOVELTY_LABELS[card.novelty]}</Fact>
          <Fact label="Depth">{DEPTH_LABELS[card.depth]}</Fact>
          <Fact label="In this feed">
            {card.hidden ? `Hidden: ${hiddenReasonText(card.hidden, card.exclusion)}` : "Shown in the main list"}
          </Fact>
          {detail.otherFeeds.length > 0 ? (
            <Fact label="Also shows in">
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {detail.otherFeeds.map((f) => (
                  <Link key={f.slug} href={`/f/${encodeURIComponent(f.slug)}/story/${card.storyId}`} className="text-accent">
                    {f.name}
                  </Link>
                ))}
              </span>
            </Fact>
          ) : null}
        </dl>
        <h3 className="mt-2 font-semibold text-fg">Why this ranks here</h3>
        <RankExplanation facts={card} variant="table" />
      </Section>

      <Section id="feedback-title" title="Feedback">
        <p className="text-sm text-muted">One vote for each browser. Votes change the rank in this feed at once.</p>
        <FeedbackButtons
          feedSlug={feed.slug}
          storyId={card.storyId}
          votes={card.votes}
          myVote={card.myVote}
          from="story"
          alertId={card.alert?.id ?? null}
        />
      </Section>

      <AnalysisSection
        analysis={detail.analysis}
        feedSlug={feed.slug}
        storyId={card.storyId}
        now={now}
        banners={banners}
        name={actor.name}
      />
    </article>
  );
}
