"use client";

import Link from "next/link";
import { useId, useOptimistic, useState, useTransition } from "react";

import { setFeedSourceAction } from "@/app/f/[slug]/settings/actions";
import {
  Badge,
  ChipToggle,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Select,
  SourceTypeIcon,
  Switch,
  fieldDescribedBy,
} from "@/components/ui";
import type { SourceStatus } from "@/lib/services/types";
import { PRIORITIES, PRIORITY_LABELS, SOURCE_TYPE_LABELS, type Priority, type SourceType } from "@/lib/types";

import {
  errorFor,
  filterFeedSources,
  groupByType,
  queuedStoriesText,
  sourceStatusBadge,
  textChanged,
  type RejudgeEstimate,
} from "./helpers";
import { RejudgeOffer } from "./RejudgeOffer";
import { SaveRow } from "./SettingsSection";
import { useSave } from "./use-save";

export interface FeedSourceItem {
  id: number;
  type: SourceType;
  name: string;
  status: SourceStatus;
  statusDetail: string | null;
  included: boolean;
  priority: Priority;
  follow: string;
  ignore: string;
}

const PRIORITY_OPTIONS = PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }));
const NETWORK_MESSAGE = "The change was not saved. Check the connection and try again.";

export interface FeedSourcesEditorProps {
  feedId: number;
  feedName: string;
  items: FeedSourceItem[];
  addHref: string;
}

/** The Sources group of the feed settings (§4.8): search, groups by type, one row per source. */
export function FeedSourcesEditor({ feedId, feedName, items, addHref }: FeedSourcesEditorProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [onlyIncluded, setOnlyIncluded] = useState(false);

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          icon="radio"
          as="h2"
          title="The directory has no sources yet"
          description="Add a source once. Then each feed can use it with its own filters."
          actions={
            <LinkButton href={addHref} variant="primary" icon="add">
              Add a new source
            </LinkButton>
          }
        />
      </>
    );
  }

  // Every row stays mounted (hidden when filtered out), so that a draft survives a search.
  const all = items.map((item) => ({ ...item, source: item }));
  const shown = filterFeedSources(all, query, onlyIncluded);
  const visible = new Set(shown.map((row) => row.id));
  const groups = groupByType(all);
  const includedCount = items.filter((item) => item.included).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <Field id={searchId} label="Search sources" className="w-full sm:max-w-sm">
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Name of a source"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <ChipToggle pressed={onlyIncluded} onClick={() => setOnlyIncluded((v) => !v)}>
          Only sources in this feed
        </ChipToggle>
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        {includedCount} of {items.length} sources are in {feedName}.
        {query.trim() || onlyIncluded ? ` Showing ${shown.length}.` : null}
      </p>
      <p className="max-w-prose text-sm text-muted">
        Follow: this feed takes only these subjects from this source. Ignore: this feed never takes these. Leave them empty
        to take everything that is relevant.
      </p>

      {shown.length === 0 ? (
        <p className="text-sm">
          {query.trim() ? `No source matches “${query.trim()}”.` : "No source is in this feed yet."}
        </p>
      ) : null}
      {groups.map((group) => {
        const count = group.rows.filter((row) => visible.has(row.id)).length;
        return (
          <section key={group.type} aria-labelledby={`group-${group.type}`} hidden={count === 0}>
            <h2 id={`group-${group.type}`} className="flex items-center gap-2 text-sm font-semibold text-fg">
              <SourceTypeIcon type={group.type} size={16} className="text-muted" />
              {SOURCE_TYPE_LABELS[group.type]}
              <span className="font-normal text-muted">· {count}</span>
            </h2>
            <ul className="mt-2 border-y border-border">
              {group.rows.map((row) => (
                <FeedSourceRow
                  key={row.id}
                  feedId={feedId}
                  item={row}
                  hidden={!visible.has(row.id)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

interface LinkDraft {
  priority: Priority;
  follow: string;
  ignore: string;
}

function FeedSourceRow({
  feedId,
  item,
  hidden,
}: {
  feedId: number;
  item: FeedSourceItem;
  hidden: boolean;
}) {
  const id = `src-${item.id}`;
  const [included, setIncluded] = useState(item.included);
  const [shownIncluded, setShownIncluded] = useOptimistic(included);
  const [togglePending, startToggle] = useTransition();
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [queued, setQueued] = useState<number | null>(null);
  const [saved, setSaved] = useState<LinkDraft>({ priority: item.priority, follow: item.follow, ignore: item.ignore });
  const [draft, setDraft] = useState<LinkDraft>(saved);
  const [offer, setOffer] = useState<RejudgeEstimate[] | null>(null);
  const save = useSave(setFeedSourceAction);
  const badge = sourceStatusBadge(item.status);
  const errors = save.failure?.fieldErrors;

  const toggle = async (next: boolean) => {
    setToggleError(null);
    setQueued(null);
    setOffer(null);
    startToggle(async () => {
      setShownIncluded(next);
      try {
        const result = await setFeedSourceAction(
          next ? { feedId, sourceId: item.id, included: true, ...draft } : { feedId, sourceId: item.id, included: false },
        );
        if (result.ok) {
          setIncluded(next);
          if (next) {
            setSaved(draft);
            setQueued(result.data.queuedStories);
          }
        } else {
          setToggleError(result.message);
        }
      } catch {
        setToggleError(NETWORK_MESSAGE);
      }
    });
  };

  return (
    <li hidden={hidden} className="flex flex-col gap-3 border-t border-border py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/sources/${item.id}`} className="font-medium break-words text-fg">
              {item.name}
            </Link>
            <Badge tone={badge.tone} title={item.statusDetail ?? undefined}>
              {badge.label}
            </Badge>
          </div>
          {item.statusDetail && item.status !== "active" ? (
            <p className="text-sm text-muted">{item.statusDetail}</p>
          ) : null}
        </div>
        <Switch
          id={`${id}-in`}
          label={
            <>
              In this feed<span className="sr-only">: {item.name}</span>
            </>
          }
          showState
          checked={shownIncluded}
          disabled={togglePending}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </div>
      {toggleError ? (
        <p role="alert" className="text-sm text-alert">
          {toggleError}
        </p>
      ) : null}
      {queued !== null ? (
        <p role="status" className="text-sm text-success">
          {queuedStoriesText(queued)}
        </p>
      ) : null}

      {shownIncluded ? (
        <form
          id={save.formId}
          noValidate
          className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            setOffer(null);
            const sent = draft;
            void save.run({ feedId, sourceId: item.id, included: true, ...sent }, (data) => {
              const judgeTimeChange = textChanged(saved.follow, sent.follow) || textChanged(saved.ignore, sent.ignore);
              setSaved(sent);
              if (judgeTimeChange) setOffer(data.estimates);
            });
          }}
        >
          <Field
            id={`${id}-priority`}
            label={
              <>
                Priority<span className="sr-only"> of {item.name}</span>
              </>
            }
            error={errorFor(errors, "priority")}
          >
            <Select
              id={`${id}-priority`}
              options={PRIORITY_OPTIONS}
              value={draft.priority}
              onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value as Priority }))}
            />
          </Field>
          <Field
            id={`${id}-follow`}
            label={
              <>
                Follow<span className="sr-only"> in {item.name}</span>
              </>
            }
            error={errorFor(errors, "follow")}
          >
            <Input
              id={`${id}-follow`}
              value={draft.follow}
              maxLength={300}
              placeholder="All subjects"
              invalid={!!errorFor(errors, "follow")}
              aria-describedby={fieldDescribedBy(`${id}-follow`, { error: errorFor(errors, "follow") })}
              onChange={(e) => setDraft((d) => ({ ...d, follow: e.target.value }))}
            />
          </Field>
          <Field
            id={`${id}-ignore`}
            label={
              <>
                Ignore<span className="sr-only"> in {item.name}</span>
              </>
            }
            error={errorFor(errors, "ignore")}
          >
            <Input
              id={`${id}-ignore`}
              value={draft.ignore}
              maxLength={300}
              placeholder="Nothing"
              invalid={!!errorFor(errors, "ignore")}
              aria-describedby={fieldDescribedBy(`${id}-ignore`, { error: errorFor(errors, "ignore") })}
              onChange={(e) => setDraft((d) => ({ ...d, ignore: e.target.value }))}
            />
          </Field>
          <SaveRow
            className="sm:col-span-3"
            pending={save.pending}
            savedAt={save.savedAt}
            error={save.failure?.message}
          />
        </form>
      ) : null}
      {offer ? (
        <RejudgeOffer estimates={offer} sourceId={item.id} onDismiss={() => setOffer(null)} />
      ) : null}
    </li>
  );
}
