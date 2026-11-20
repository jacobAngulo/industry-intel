import type { Metadata } from "next";
import Link from "next/link";

import { getActor } from "@/app/_lib/identity";
import { DeleteSourceButton } from "@/components/sources/DeleteSourceButton";
import { FlashMessage } from "@/components/sources/FlashMessage";
import { SOURCE_STATUS_LABELS, SOURCE_STATUS_ORDER, formatSignalRate, plural, sourceNoteLine } from "@/components/sources/labels";
import { SetNameButton } from "@/components/sources/SetNameButton";
import { SourceStatusBadge } from "@/components/sources/StatusBadge";
import {
  Banner,
  Button,
  Chip,
  ChipLink,
  EmptyState,
  Field,
  Icon,
  Input,
  LinkButton,
  PageContainer,
  PageHeader,
  RelativeTime,
  Select,
  SourceTypeIcon,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Textarea,
  Tr,
} from "@/components/ui";
import { listFeeds, listSources, type FeedSummary, type SourceRow } from "@/lib/services";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS, type SourceType } from "@/lib/types";
import { nowMs } from "@/lib/time";

import { LIST_MECHANISM_TYPES, directoryHref, hasFilters, parseDirectoryQuery, type DirectoryQuery, type SearchParams } from "./query";

export const metadata: Metadata = { title: "Sources" };

const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "last_check", label: "Last successful check" },
  { value: "useful", label: "Useful stories" },
];

const ADD_MORE_PLACEHOLDER: Partial<Record<SourceType, string>> = {
  x_user: "@chamath\n@sama",
  x_search: "coding agents\nagent evaluations",
  podcast: "All-In\nLatent Space",
};

export default async function SourcesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = parseDirectoryQuery(await searchParams);
  const [actor, feeds] = await Promise.all([getActor(), listFeeds()]);
  const activeFeeds = feeds.filter((f) => !f.archived).sort((a, b) => a.position - b.position || a.id - b.id);
  const feed = query.feed ? (activeFeeds.find((f) => String(f.id) === query.feed || f.slug === query.feed) ?? null) : null;
  const ownerBlocked = query.ownerMe && !actor.name;

  const rows = ownerBlocked
    ? []
    : await listSources({
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(feed ? { feedId: feed.id } : {}),
        ...(query.ownerMe && actor.name ? { owner: actor.name } : {}),
        ...(query.q ? { q: query.q } : {}),
        sort: query.sort,
      });
  const now = nowMs();
  const listMode = query.type !== null && LIST_MECHANISM_TYPES.includes(query.type);
  const filtered = hasFilters(query) || (query.feed !== null && feed === null);
  const addHref = `/sources/new${query.type || feed ? `?${new URLSearchParams({ ...(query.type ? { type: query.type } : {}), ...(feed ? { feed: feed.slug } : {}) })}` : ""}`;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Sources"
        description="The shared source directory. Add a source once, then use it in as many feeds as you like."
        actions={
          <LinkButton href={addHref} variant="primary" icon="add">
            Add source
          </LinkButton>
        }
      />
      <FlashMessage />

      <nav aria-label="Source types" className="mb-5">
        <ul className="flex flex-wrap gap-2">
          <li>
            <ChipLink href={directoryHref(query, { type: null })} selected={query.type === null}>
              All types
            </ChipLink>
          </li>
          {SOURCE_TYPES.map((type) => (
            <li key={type}>
              <ChipLink href={directoryHref(query, { type })} selected={query.type === type}>
                <SourceTypeIcon type={type} size={14} />
                {SOURCE_TYPE_LABELS[type]}
              </ChipLink>
            </li>
          ))}
        </ul>
      </nav>

      <FilterForm query={query} feeds={activeFeeds} />

      {ownerBlocked ? (
        <Banner tone="info" className="mb-5" actions={<SetNameButton />}>
          &quot;Owner: me&quot; matches the owner field with your display name. Set your name first.
        </Banner>
      ) : null}
      {query.feed !== null && feed === null ? (
        <Banner tone="warning" className="mb-5">
          The feed in the address does not exist or is archived, so the list shows no source.
        </Banner>
      ) : null}

      <p className="mb-3 text-sm text-muted" aria-live="polite">
        {plural(query.feed !== null && feed === null ? 0 : rows.length, "source", "sources")}
        {query.type ? ` of the type ${SOURCE_TYPE_LABELS[query.type]}` : ""}
        {filtered ? (rows.length === 1 && !(query.feed !== null && feed === null) ? " matches the filters" : " match the filters") : ""}
        {query.ownerMe && actor.name ? ` · owner ${actor.name}, flagged sources first` : ""}
      </p>

      {(query.feed !== null && feed === null) || ownerBlocked ? null : rows.length === 0 ? (
        <EmptyResult query={query} filtered={filtered} addHref={addHref} />
      ) : listMode ? (
        <CompactList rows={rows} name={actor.name} />
      ) : (
        <>
          <div className="hidden md:block">
            <SourceTable rows={rows} now={now} />
          </div>
          <ul className="flex flex-col divide-y divide-border border-y border-border md:hidden">
            {rows.map((row) => (
              <SourceCard key={row.id} row={row} now={now} />
            ))}
          </ul>
        </>
      )}

      {listMode && query.type ? <AddMoreBox type={query.type} feedSlug={feed?.slug ?? null} /> : null}
    </PageContainer>
  );
}

function FilterForm({ query, feeds }: { query: DirectoryQuery; feeds: FeedSummary[] }) {
  return (
    <form method="get" action="/sources" role="search" aria-label="Filter the sources" className="mb-5">
      {query.type ? <input type="hidden" name="type" value={query.type} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1.4fr)_1fr_1fr_1fr_auto] lg:items-end">
        <Field id="sources-q" label="Search by name">
          <Input id="sources-q" name="q" type="search" defaultValue={query.q} maxLength={120} placeholder="Name" />
        </Field>
        <Field id="sources-status" label="Status">
          <Select
            id="sources-status"
            name="status"
            defaultValue={query.status ?? ""}
            options={[{ value: "", label: "All statuses" }, ...SOURCE_STATUS_ORDER.map((s) => ({ value: s, label: SOURCE_STATUS_LABELS[s] }))]}
          />
        </Field>
        <Field id="sources-feed" label="Feed">
          <Select
            id="sources-feed"
            name="feed"
            defaultValue={feeds.find((f) => String(f.id) === query.feed || f.slug === query.feed)?.id.toString() ?? ""}
            options={[{ value: "", label: "All feeds" }, ...feeds.map((f) => ({ value: String(f.id), label: f.name }))]}
          />
        </Field>
        <Field id="sources-sort" label="Sort by">
          <Select id="sources-sort" name="sort" defaultValue={query.sort} options={SORT_OPTIONS} />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-1">
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" name="owner" value="me" defaultChecked={query.ownerMe} className="h-4 w-4 accent-accent" />
            Owner: me
          </label>
          <Button type="submit" variant="secondary" icon="search">
            Apply
          </Button>
          {hasFilters(query) ? (
            <Link href={directoryHref(query, { status: null, feed: null, ownerMe: false, q: "", sort: "name" })} className="text-sm text-muted underline hover:text-fg">
              Clear filters
            </Link>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function EmptyResult({ query, filtered, addHref }: { query: DirectoryQuery; filtered: boolean; addHref: string }) {
  if (filtered) {
    return (
      <EmptyState
        icon="search"
        title="No source matches these filters"
        description="Change or clear the filters to see more sources."
        actions={
          <LinkButton href={directoryHref(query, { status: null, feed: null, ownerMe: false, q: "" })} variant="secondary">
            Clear filters
          </LinkButton>
        }
      />
    );
  }
  if (query.type) {
    return (
      <EmptyState
        icon="radio"
        title={`No ${SOURCE_TYPE_LABELS[query.type]} source yet`}
        description={
          LIST_MECHANISM_TYPES.includes(query.type)
            ? "Use the box below to add several at once, one per line."
            : "Add one to make it available to every feed."
        }
        actions={
          LIST_MECHANISM_TYPES.includes(query.type) ? undefined : (
            <LinkButton href={addHref} variant="primary" icon="add">
              Add source
            </LinkButton>
          )
        }
      />
    );
  }
  return (
    <EmptyState
      icon="radio"
      title="The directory is empty"
      description="Start with vendor changelogs, GitHub releases, and engineering blogs alongside your X and podcast lists."
      actions={
        <LinkButton href={addHref} variant="primary" icon="add">
          Add source
        </LinkButton>
      }
    />
  );
}

function FeedChips({ feeds }: { feeds: SourceRow["feeds"] }) {
  if (feeds.length === 0) return <span className="text-sm text-muted">Not in any feed</span>;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Feeds">
      {feeds.map((f) => (
        <li key={f.id}>
          <Chip>{f.name}</Chip>
        </li>
      ))}
    </ul>
  );
}

function StatusCell({ row }: { row: SourceRow }) {
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <SourceStatusBadge status={row.status} detail={row.statusDetail} />
    </span>
  );
}

/** The visible note under the name (§13): the failing hint, the status detail, or the first hint. */
function NoteLine({ row, className }: { row: SourceRow; className: string }) {
  const note = sourceNoteLine(row);
  return note ? <p className={className}>{note}</p> : null;
}

function LastSuccess({ at, now }: { at: number | null; now: number }) {
  return at === null ? <span className="text-muted">Never</span> : <RelativeTime at={at} now={now} />;
}

function Flags({ n }: { n: number }) {
  if (n === 0) return <span className="text-muted">None</span>;
  return (
    <span className="inline-flex items-center gap-1 text-warning">
      <Icon name="flag" size={14} />
      {plural(n, "open flag", "open flags")}
    </span>
  );
}

function SourceTable({ rows, now }: { rows: SourceRow[]; now: number }) {
  return (
    <Table caption="Sources in the directory" captionHidden>
      <THead>
        <Tr>
          <Th>Name</Th>
          <Th>Type</Th>
          <Th>Status</Th>
          <Th>Feeds</Th>
          <Th>Last success</Th>
          <Th>Useful stories</Th>
          <Th>Noisy flags</Th>
          <Th>Added by · owner</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td className="min-w-[14rem]">
              <Link href={`/sources/${row.id}`} className="font-medium text-fg underline-offset-2 hover:underline">
                {row.name}
              </Link>
              <NoteLine row={row} className="mt-1 max-w-xs text-xs break-words text-muted" />
            </Td>
            <Td>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <SourceTypeIcon type={row.type} size={14} className="text-muted" />
                {SOURCE_TYPE_LABELS[row.type]}
              </span>
            </Td>
            <Td>
              <StatusCell row={row} />
            </Td>
            <Td className="min-w-[9rem]">
              <FeedChips feeds={row.feeds} />
            </Td>
            <Td>
              <LastSuccess at={row.lastSuccessAt} now={now} />
            </Td>
            <Td className="whitespace-nowrap">
              <span className="tabular-nums">Useful stories: {row.usefulStories}</span>
              <span className="block text-xs text-muted">Signal rate {formatSignalRate(row.signalRate)}</span>
            </Td>
            <Td className="whitespace-nowrap">
              <Flags n={row.openFlags} />
            </Td>
            <Td className="text-sm">
              <span className="block">{row.addedBy}</span>
              <span className="block text-xs text-muted">{row.owner ? `Owner: ${row.owner}` : "No owner"}</span>
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

function SourceCard({ row, now }: { row: SourceRow; now: number }) {
  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/sources/${row.id}`} className="min-w-0 font-medium break-words text-fg underline-offset-2 hover:underline">
          {row.name}
        </Link>
        <SourceStatusBadge status={row.status} detail={row.statusDetail} />
      </div>
      <p className="flex items-center gap-1.5 text-sm text-muted">
        <SourceTypeIcon type={row.type} size={14} />
        {SOURCE_TYPE_LABELS[row.type]}
      </p>
      <NoteLine row={row} className="text-sm break-words text-muted" />
      <FeedChips feeds={row.feeds} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Last success</dt>
        <dd>
          <LastSuccess at={row.lastSuccessAt} now={now} />
        </dd>
        <dt className="text-muted">Useful stories</dt>
        <dd className="tabular-nums">
          {row.usefulStories} · signal {formatSignalRate(row.signalRate)}
        </dd>
        <dt className="text-muted">Noisy flags</dt>
        <dd>
          <Flags n={row.openFlags} />
        </dd>
        <dt className="text-muted">Added by</dt>
        <dd className="break-words">{row.addedBy}</dd>
        <dt className="text-muted">Owner</dt>
        <dd className="break-words">{row.owner ?? "No owner"}</dd>
      </dl>
      {row.hints[0] && row.hints[0] !== sourceNoteLine(row) ? <p className="text-sm text-muted">{row.hints[0]}</p> : null}
    </li>
  );
}

/** §4.5 list mechanism: one line for each source. */
function CompactList({ rows, name }: { rows: SourceRow[]; name: string | null }) {
  return (
    <ul className="flex flex-col divide-y divide-border border-y border-border">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
          <span className="flex min-w-0 flex-col gap-0.5 sm:w-64 sm:shrink-0">
            <Link href={`/sources/${row.id}`} className="font-medium break-words text-fg underline-offset-2 hover:underline">
              {row.name}
            </Link>
            <NoteLine row={row} className="text-xs break-words text-muted" />
          </span>
          <span className="inline-flex flex-wrap items-center gap-2 sm:w-44 sm:shrink-0">
            <StatusCell row={row} />
          </span>
          <span className="min-w-0 flex-1">
            <FeedChips feeds={row.feeds} />
          </span>
          <span className="shrink-0">
            <DeleteSourceButton sourceId={row.id} sourceName={row.name} name={name} label="Remove" variant="ghost" size="sm" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Add more: one per line": opens step 1 of the add-source flow with the type forced and the entries filled in. */
function AddMoreBox({ type, feedSlug }: { type: SourceType; feedSlug: string | null }) {
  return (
    <section aria-labelledby="add-more-heading" className="mt-8 max-w-xl">
      <h2 id="add-more-heading" className="mb-1 font-medium">
        Add more {SOURCE_TYPE_LABELS[type]} sources
      </h2>
      <form method="get" action="/sources/new" className="flex flex-col gap-3">
        <input type="hidden" name="type" value={type} />
        {feedSlug ? <input type="hidden" name="feed" value={feedSlug} /> : null}
        <Field id="add-more" label="Add more: one per line" hint="The next page finds each one. Nothing is added before you confirm.">
          <Textarea id="add-more" name="entries" rows={4} maxLength={4000} placeholder={ADD_MORE_PLACEHOLDER[type]} aria-describedby="add-more-hint" />
        </Field>
        <div>
          <Button type="submit" variant="primary" iconEnd="arrowRight">
            Continue
          </Button>
        </div>
      </form>
    </section>
  );
}
