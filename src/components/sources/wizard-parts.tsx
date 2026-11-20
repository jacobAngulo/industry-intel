"use client";

// Presentational parts of the add-source flow (specification §4.7).
import Link from "next/link";
import type { RefObject } from "react";

import { Badge, Banner, Meter, RelativeTime, SourceTypeIcon, Spinner, cn } from "@/components/ui";
import type { PreviewResult, QualifyResult } from "@/lib/services/types";
import { SOURCE_TYPE_LABELS } from "@/lib/types";

import { hiddenReasonText, isHttpUrl, plural } from "./labels";
import type { WizardCandidate } from "./wizard-logic";

export const STEP_NAMES = ["What to follow", "Choose what matters", "Preview", "Add"] as const;

/** The list of steps; the current one has aria-current="step". */
export function StepList({ step }: { step: number }) {
  return (
    <ol aria-label="Steps" className="mb-8 flex flex-wrap gap-x-6 gap-y-2 border-b border-border pb-4 text-sm">
      {STEP_NAMES.map((label, index) => {
        const n = index + 1;
        const state = n < step ? "done" : n === step ? "current" : "next";
        return (
          <li key={label} aria-current={state === "current" ? "step" : undefined} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold",
                state === "current" && "border-accent bg-accent text-accent-fg",
                state === "done" && "border-accent bg-accent-soft text-accent",
                state === "next" && "border-border text-muted",
              )}
            >
              {n}
            </span>
            <span className={cn(state === "current" ? "font-medium text-fg" : "text-muted")}>
              {label}
              {state === "done" ? <span className="sr-only"> (done)</span> : null}
              {state === "current" ? <span className="sr-only"> (current step)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The heading of a step; it takes the focus after each step change. */
export function StepHeading({ step, headingRef }: { step: number; headingRef: RefObject<HTMLHeadingElement | null> }) {
  return (
    <h2 ref={headingRef} tabIndex={-1} className="mb-4 font-serif text-xl font-semibold outline-none">
      <span className="text-muted">Step {step} of 4: </span>
      {step === 1 ? "What do you want to follow?" : step === 2 ? "Choose what matters" : step === 3 ? "Preview" : "Add"}
    </h2>
  );
}

/** The text of a candidate card (§4.7 step 1). */
export function CandidateBody({ candidate }: { candidate: WizardCandidate }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <SourceTypeIcon type={candidate.type} size={16} className="text-muted" />
        <span className="font-medium break-words">{candidate.name}</span>
        <span className="text-sm text-muted">{SOURCE_TYPE_LABELS[candidate.type]}</span>
      </span>
      {candidate.description ? <span className="text-sm text-muted">{candidate.description}</span> : null}
      {candidate.url ? <span className="text-xs break-all text-muted">{candidate.url}</span> : null}
      {(candidate.warnings ?? []).length > 0 || candidate.existing ? (
        <span className="flex flex-wrap gap-1.5 pt-0.5">
          {candidate.existing ? (
            <Badge tone="accent" icon="info">
              Already in the directory
            </Badge>
          ) : null}
          {(candidate.warnings ?? []).map((warning) => (
            <Badge key={warning} tone="warning" icon="warning">
              {warning}
            </Badge>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** "Already in the directory" with a link and the offer to add the source to more feeds. */
export function ExistingNote({ source }: { source: { id: number; name: string } }) {
  return (
    <Banner tone="info" title="Already in the directory">
      <p>
        <Link href={`/sources/${source.id}`} className="font-medium text-accent underline">
          {source.name}
        </Link>{" "}
        is in the directory. You do not need to add it again.{" "}
        <Link href={`/sources/${source.id}#feeds`} className="text-accent underline">
          Add it to more feeds
        </Link>
        .
      </p>
    </Banner>
  );
}

/** The recent items of each entry (§4.7 step 3). */
export function PreviewList({ preview }: { preview: PreviewResult }) {
  return (
    <div className="flex flex-col gap-6">
      {preview.entries.map((entry, index) => (
        <section key={`${entry.name}-${index}`} aria-labelledby={`preview-${index}`} className="flex flex-col gap-3">
          <h3 id={`preview-${index}`} className="font-medium">
            {entry.name}
          </h3>
          {entry.note ? <Banner tone="info">{entry.note}</Banner> : null}
          {entry.error ? (
            <Banner tone="warning" title="The preview did not work">
              <p>{entry.error}</p>
              <p className="mt-1">You can still add the source. The worker tries again at each check.</p>
            </Banner>
          ) : null}
          {!entry.error && entry.items.length === 0 ? (
            <p className="text-sm text-muted">The source returned no recent item. New items show after the next checks.</p>
          ) : null}
          {entry.items.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
              {entry.items.map((item) => (
                <li key={item.externalId} className="flex flex-col gap-1 px-4 py-3">
                  <span className="font-medium break-words">
                    {isHttpUrl(item.url) ? (
                      <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" className="text-fg underline-offset-2 hover:underline">
                        {item.title || "(no title)"}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      item.title || "(no title)"
                    )}
                  </span>
                  <span className="text-xs text-muted">
                    {item.publishedAt !== null ? <RelativeTime at={item.publishedAt} /> : "No date"}
                  </span>
                  {item.excerpt ? <p className="line-clamp-3 text-sm text-muted">{item.excerpt}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/** Which recent items would enter each selected feed (§4.7 step 3). */
export function QualifyView({
  result,
  pending,
  error,
  noFeeds,
}: {
  result: QualifyResult | null;
  pending: boolean;
  error: string | null;
  noFeeds: boolean;
}) {
  return (
    <section aria-labelledby="qualify-heading" className="flex flex-col gap-3">
      <h3 id="qualify-heading" className="font-medium">
        Would they enter your feeds?
      </h3>
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {noFeeds ? (
          <p className="text-sm text-muted">Select a feed in step 2 to see which recent items would enter it.</p>
        ) : pending ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={16} label={null} />
            The model checks up to 5 recent items against the selected feeds…
          </p>
        ) : error ? (
          <Banner tone="warning">{error} You can still add the source.</Banner>
        ) : result && !result.available ? (
          <Banner tone="info" title="The model check is not available">
            {result.unavailableReason ?? "You can still add the source."}
          </Banner>
        ) : result ? (
          result.perFeed.map((feed) => (
            <div key={feed.feedId} className="flex flex-col gap-2">
              <p className="font-medium">
                {feed.wouldEnter} of {plural(feed.total, "recent item", "recent items")} would enter {feed.feedName}
              </p>
              <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
                {feed.items.map((item) => (
                  <li key={item.externalId} className="flex flex-col gap-1 px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      {item.wouldEnter ? (
                        <Badge tone="success" icon="check">
                          Would enter
                        </Badge>
                      ) : (
                        <Badge tone="neutral" icon="hide">
                          Filtered{item.hidden ? `: ${hiddenReasonText(item.hidden)}` : ""}
                        </Badge>
                      )}
                      <Meter value={item.relevance} compact />
                    </span>
                    <span className="break-words">{item.title || "(no title)"}</span>
                    {item.reason ? <span className="text-sm text-muted">{item.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : null}
      </div>
    </section>
  );
}
