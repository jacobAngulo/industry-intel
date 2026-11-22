import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requireUser } from "@/app/_lib/identity";
import { AutoRefresh } from "@/components/AutoRefresh";
import { FeedLinkRow } from "@/components/sources/FeedLinkRow";
import { FlagsPanel } from "@/components/sources/FlagsPanel";
import { FlashMessage } from "@/components/sources/FlashMessage";
import { SKIP_REASON_LABELS, formatInterval, formatSignalRate, isHttpUrl, itemOutcomeText } from "@/components/sources/labels";
import { SourceAboutForm } from "@/components/sources/SourceAboutForm";
import { SourceConfigEditor } from "@/components/sources/SourceConfigEditor";
import { SourceHeaderActions } from "@/components/sources/SourceHeaderActions";
import { SourceStatusBadge } from "@/components/sources/StatusBadge";
import {
  Badge,
  Banner,
  Icon,
  PageContainer,
  PageHeader,
  RelativeTime,
  SourceTypeIcon,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  cn,
  formatAbsoluteUtc,
} from "@/components/ui";
import { IDENTITY_FIELDS } from "@/lib/connectors/configs";
import { getSource, type ItemOutcome, type SourceDetail } from "@/lib/services";
import { nowMs } from "@/lib/time";
import { FEEDBACK_REASONS, FEEDBACK_REASON_LABELS, SOURCE_TYPE_DEFAULTS, SOURCE_TYPE_LABELS } from "@/lib/types";

type Params = Promise<{ id: string }>;

function parseId(raw: string): number | null {
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const id = parseId((await params).id);
  const source = id === null ? null : await getSource(id);
  return { title: source ? source.name : "Source not found" };
}

export default async function SourcePage({ params }: { params: Params }) {
  const id = parseId((await params).id);
  if (id === null) notFound();
  const [source] = await Promise.all([getSource(id), requireUser()]);
  if (!source) notFound();
  const now = nowMs();
  const waiting = source.checkRequested || source.status === "waiting";
  const needsSetup = source.status === "needs_token" || source.status === "needs_setup";

  return (
    <PageContainer width="wide">
      <AutoRefresh everyMs={3000} active={waiting && source.status !== "paused" && !needsSetup} />
      <PageHeader
        eyebrow={
          <Link href={`/sources?type=${source.type}`} className="text-muted underline hover:text-fg">
            Sources · {SOURCE_TYPE_LABELS[source.type]}
          </Link>
        }
        title={source.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <SourceTypeIcon type={source.type} size={16} />
              {SOURCE_TYPE_LABELS[source.type]}
            </span>
            <SourceStatusBadge status={source.status} detail={source.statusDetail} />
            {isHttpUrl(source.url) ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-accent underline">
                Open the origin
                <Icon name="external" size={14} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </span>
        }
        actions={
          <SourceHeaderActions
            sourceId={source.id}
            sourceName={source.name}
            paused={source.status === "paused"}
            checkRequested={source.checkRequested}
            itemCount={source.itemCount}
            soleStoryCount={source.soleStoryCount}
          />
        }
      />
      <FlashMessage />

      <div className="mb-8 flex flex-col gap-2">
        {needsSetup && source.statusDetail ? (
          <Banner tone="warning" title={source.status === "needs_token" ? "Needs token" : "Needs setup"}>
            {source.statusDetail} Until then the worker does not check this source.
          </Banner>
        ) : null}
        {source.status === "failing" && source.lastError && !source.hints.some((h) => h.startsWith("Failing since")) ? (
          <Banner tone="warning" title="Failing">
            {source.lastError}
          </Banner>
        ) : null}
        {source.hints.map((hint) => (
          <Banner key={hint} tone={hint.startsWith("Failing since") ? "warning" : "info"}>
            {hint}
          </Banner>
        ))}
        {source.checkRequested && source.status !== "paused" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <Icon name="clock" size={14} />A check is requested. This page updates when it is done.
          </p>
        ) : source.status === "waiting" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <Icon name="clock" size={14} />
            Waiting for the first check. This page updates when it is done.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-12">
        <Section title="About this source" id="about">
          <dl className="mb-6 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
            <Fact label="Why it matters">{source.why}</Fact>
            <Fact label="Added by">
              {source.addedBy} on <time dateTime={new Date(source.createdAt).toISOString()}>{formatAbsoluteUtc(source.createdAt)}</time>
            </Fact>
            <Fact label="Owner">{source.owner ?? "No owner"}</Fact>
            <Fact label="Check interval">{formatInterval(source.checkIntervalMinutes)}</Fact>
            <Fact label="Last successful check">
              {source.lastSuccessAt !== null ? <RelativeTime at={source.lastSuccessAt} now={now} /> : "Never"}
            </Fact>
            <Fact label="Next check">
              {source.status === "paused" ? "Paused" : needsSetup ? "After the setup" : <RelativeTime at={source.nextCheckAt} now={now} />}
            </Fact>
          </dl>
          <SourceAboutForm
            sourceId={source.id}
            initial={{ name: source.name, why: source.why, owner: source.owner, checkIntervalMinutes: source.checkIntervalMinutes }}
            typeDefaultInterval={SOURCE_TYPE_DEFAULTS[source.type].intervalMinutes}
          />
        </Section>

        <Section
          title="Settings"
          id="settings"
          description="What the app takes from this source. The fields that identify the source cannot change."
        >
          <SourceConfigEditor
            sourceId={source.id}
            type={source.type}
            config={source.config}
            identityFields={IDENTITY_FIELDS[source.type]}
          />
        </Section>

        <Section title="Feeds" id="feeds" description="Each feed applies its own filters to this source.">
          {source.feedLinks.length === 0 ? (
            <p className="text-sm text-muted">
              There is no active feed. <Link href="/feeds/new" className="text-accent underline">Create a feed</Link> first.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {source.feedLinks.map((link) => (
                <FeedLinkRow key={link.feedId} sourceId={source.id} feed={link} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Health" id="health" description="The last 20 checks.">
          <Health checks={source.checks} now={now} />
        </Section>

        <Section title="Statistics (30 days)" id="statistics">
          <Statistics source={source} />
        </Section>

        <Section title="Noisy flags" id="flags" description="Anyone can flag a source as noisy. The owner can then narrow its filters or pause it.">
          <Flags flags={source.flags} now={now} />
          <div className="mt-4">
            <FlagsPanel sourceId={source.id} openFlags={source.openFlags} />
          </div>
        </Section>

        <Section title="Recent items" id="items" description="The last 20 items, with the outcome in each feed.">
          <RecentItems items={source.recentItems} now={now} />
        </Section>
      </div>
    </PageContainer>
  );
}

function Section({ title, id, description, children }: { title: string; id: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} id={id} className="scroll-mt-20 border-t border-border pt-6">
      <h2 id={`${id}-heading`} className="font-serif text-xl font-semibold">
        {title}
      </h2>
      {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

function Health({ checks, now }: { checks: SourceDetail["checks"]; now: number }) {
  if (checks.length === 0) return <p className="text-sm text-muted">No check yet.</p>;
  return (
    <Table caption="The last 20 checks, newest first" captionHidden dense>
      <THead>
        <Tr>
          <Th>Time</Th>
          <Th>Result</Th>
          <Th className="text-right">Items found</Th>
          <Th className="text-right">New items</Th>
          <Th>Error</Th>
        </Tr>
      </THead>
      <TBody>
        {checks.map((check, index) => (
          <Tr key={`${check.startedAt}-${index}`}>
            <Td className="whitespace-nowrap">
              <RelativeTime at={check.startedAt} now={now} />
            </Td>
            <Td>
              {check.ok ? (
                <Badge tone="success" icon="check">
                  OK
                </Badge>
              ) : (
                <Badge tone="alert" icon="failed">
                  Failed
                </Badge>
              )}
            </Td>
            <Td className="text-right tabular-nums">{check.itemsFound}</Td>
            <Td className="text-right tabular-nums">{check.itemsNew}</Td>
            <Td className="min-w-[12rem] text-sm break-words text-muted">{check.error ?? ""}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

function Statistics({ source }: { source: SourceDetail }) {
  const s = source.stats;
  const cells: Array<[string, ReactNode]> = [
    ["Items fetched", s.itemsFetched],
    ["Items judged", s.itemsJudged],
    ["Stories shown in a feed", s.storiesShown],
    ["Signal rate (shown ÷ judged)", formatSignalRate(s.signalRate)],
    ["Useful stories (all time)", s.usefulStories],
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cells.map(([label, value]) => (
          <div key={label} className="rounded-card border border-border bg-surface px-4 py-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="mb-2 text-sm font-medium">Votes on its stories</h3>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {FEEDBACK_REASONS.map((reason) => (
            <li key={reason}>
              <span className="text-muted">{FEEDBACK_REASON_LABELS[reason]}:</span>{" "}
              <span className="tabular-nums">{s.votes[reason]}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Flags({ flags, now }: { flags: SourceDetail["flags"]; now: number }) {
  if (flags.length === 0) return <p className="text-sm text-muted">Nobody flagged this source.</p>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
      {flags.map((flag) => (
        <li key={flag.id} className={cn("flex flex-col gap-1 px-4 py-3 text-sm", flag.resolvedAt !== null && "text-muted")}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{flag.createdBy}</span>
            <RelativeTime at={flag.createdAt} now={now} className="text-muted" />
            {flag.resolvedAt !== null ? (
              <Badge tone="neutral" icon="check">
                Resolved{flag.resolvedBy ? ` by ${flag.resolvedBy}` : ""}
              </Badge>
            ) : (
              <Badge tone="warning" icon="flag">
                Open
              </Badge>
            )}
          </span>
          {flag.note ? <span className="break-words">{flag.note}</span> : <span className="text-muted">No note.</span>}
        </li>
      ))}
    </ul>
  );
}

const OUTCOME_TONE: Record<ReturnType<typeof itemOutcomeText>["tone"], string> = {
  shown: "text-success",
  filtered: "text-muted",
  waiting: "text-accent",
  skipped: "text-muted",
  failed: "text-alert",
  none: "text-muted",
};

function statusWithoutFeed(item: ItemOutcome): string {
  if (item.judgeStatus === "pending") return "Waiting for the model";
  if (item.judgeStatus === "failed") return "Failed: the model could not judge it";
  if (item.judgeStatus === "skipped") {
    return `Skipped: ${item.skipReason ? (SKIP_REASON_LABELS[item.skipReason] ?? item.skipReason) : "no reason given"}`;
  }
  return "Judged. The source is in no feed now.";
}

function RecentItems({ items, now }: { items: ItemOutcome[]; now: number }) {
  if (items.length === 0) return <p className="text-sm text-muted">No item yet. Items show here after the first successful check.</p>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
      {items.map((item) => (
        <li key={item.itemId} className="flex flex-col gap-1.5 px-4 py-3">
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
            {item.publishedAt !== null ? (
              <>
                Published <RelativeTime at={item.publishedAt} now={now} /> ·{" "}
              </>
            ) : null}
            Fetched <RelativeTime at={item.fetchedAt} now={now} />
            {item.storyId !== null ? " · in a story" : ""}
          </span>
          {item.perFeed.length === 0 ? (
            <p className="text-sm text-muted">{statusWithoutFeed(item)}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-sm">
              {item.perFeed.map((feed) => {
                const outcome = itemOutcomeText(item, feed);
                return (
                  <li key={feed.feedSlug} className="flex flex-wrap gap-x-2">
                    <Link href={`/f/${feed.feedSlug}`} className="text-fg underline-offset-2 hover:underline">
                      {feed.feedName}
                    </Link>
                    <span className={OUTCOME_TONE[outcome.tone]}>{outcome.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

