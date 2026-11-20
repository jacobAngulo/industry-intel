import Link from "next/link";
import type { ReactNode } from "react";

import { Disclosure, Icon, Meter } from "@/components/ui";
import type { StoryCard as StoryCardData } from "@/lib/services/types";

import { CardFrame } from "./CardFrame";
import { FeedbackButtons } from "./FeedbackButtons";
import { hiddenReasonText, hostOf, safeHttpUrl } from "./format";
import { ModelText } from "./ModelText";
import { RankExplanation } from "./RankExplanation";
import { StoryMeta } from "./StoryMeta";

export function storyHref(feedSlug: string, storyId: number): string {
  return `/f/${encodeURIComponent(feedSlug)}/story/${storyId}`;
}

/** A label in front of a brief line ("What changed", "Why it matters", "Suggested action"). */
export function BriefLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-pretty break-words">
      <span className="mr-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{label}</span>
      {children}
    </p>
  );
}

/** The external-link icon next to a headline (http / https only). */
export function ExternalIconLink({ url, label = "Open the original" }: { url: string | null; label?: string }) {
  const safe = safeHttpUrl(url);
  if (!safe) return null;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={`${label} (${hostOf(safe)})`}
      className="ml-1.5 inline-flex min-h-6 min-w-6 items-center justify-center rounded-control align-[-0.1em] text-muted hover:text-accent"
    >
      <Icon name="external" size={16} />
      <span className="sr-only">
        {label} at {hostOf(safe)} (opens in a new tab)
      </span>
    </a>
  );
}

function analysisLinkText(status: StoryCardData["analysisStatus"]): string {
  if (status === "done") return "Analysis ready";
  if (status === "queued" || status === "running") return "Analysis in progress";
  return "Deeper analysis";
}

export interface StoryCardProps {
  card: StoryCardData;
  feedSlug: string;
  /** The time of the server render (for RelativeTime). */
  now: number;
  /** "list": the main list (a negative vote collapses the card); "filtered": the filtered list with the hidden reason. */
  mode: "list" | "filtered";
}

/**
 * One story of the feed page (§4.1): meta line, headline, what changed, why
 * it matters, suggested action, then relevance, the rank explanation, the
 * feedback buttons, and the link to the deeper analysis.
 */
export function StoryCard({ card, feedSlug, now, mode }: StoryCardProps) {
  const href = storyHref(feedSlug, card.storyId);
  const titleId = `story-${card.storyId}-title`;
  const body = (
    <article aria-labelledby={titleId} className="flex flex-col gap-2.5">
      <StoryMeta card={card} now={now} showAlert={mode === "list"} />
      <h2 id={titleId} className="font-serif text-[1.25rem] leading-snug font-semibold text-balance break-words text-fg sm:text-[1.375rem]">
        <Link href={href} className="text-fg no-underline decoration-1 underline-offset-2 hover:underline">
          {card.headline}
        </Link>
        <ExternalIconLink url={card.primaryUrl} />
      </h2>
      <div className="flex flex-col gap-1.5 leading-relaxed">
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
      {mode === "filtered" && card.hidden ? (
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Icon name="hide" size={14} />
          <span>
            Hidden: <span className="font-medium text-fg">{hiddenReasonText(card.hidden, card.exclusion)}</span>
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <Meter value={card.relevance} />
        <Disclosure summary="Why this ranks here" className="open:order-last open:basis-full">
          <RankExplanation facts={card} />
        </Disclosure>
        <Link
          href={`${href}#analysis`}
          className="inline-flex min-h-10 items-center gap-1 text-sm text-accent no-underline hover:underline sm:ml-auto sm:min-h-8"
        >
          {card.analysisStatus === "done" ? <Icon name="checkCircle" size={14} /> : <Icon name="sparkles" size={14} />}
          {analysisLinkText(card.analysisStatus)}
          <span className="sr-only">: {card.headline}</span>
        </Link>
      </div>
      <FeedbackButtons
        feedSlug={feedSlug}
        storyId={card.storyId}
        votes={card.votes}
        myVote={card.myVote}
        from={mode}
        alertId={card.alert?.id ?? null}
      />
    </article>
  );
  if (mode === "list") {
    return (
      <CardFrame feedSlug={feedSlug} storyId={card.storyId} headline={card.headline}>
        {body}
      </CardFrame>
    );
  }
  return body;
}
