import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getActor } from "@/app/_lib/identity";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banners } from "@/components/Banners";
import { AlertBanner, DismissHiddenAlerts } from "@/components/feed/AlertBanner";
import { LatestDigestLink } from "@/components/feed/DigestsSeen";
import {
  FEED_SORTS,
  FEED_WINDOWS,
  LIMIT_STEP,
  SORT_LABELS,
  WINDOW_LABELS,
  feedHref,
  parseFeedQuery,
  widerWindow,
  type FeedQuery,
} from "@/components/feed/feed-query";
import {
  alertsHiddenForMe,
  allAlertsFound,
  backfillText,
  collectAlerts,
  collectTopics,
  feedSourceProblems,
  type FeedSourceProblem,
} from "@/components/feed/feed-view";
import { loadActiveFeed } from "@/components/feed/load-feed";
import { SuggestionList } from "@/components/feed/SuggestionList";
import { countLabel } from "@/components/story/format";
import { FeedStoryList } from "@/components/story/FeedStoryList";
import { StoryCard } from "@/components/story/StoryCard";
import {
  ChipLink,
  EmptyState,
  Icon,
  LinkButton,
  RelativeTime,
  SegmentedControl,
} from "@/components/ui";
import {
  getBanners,
  latestDigest,
  listFeedSources,
  listFeedStories,
  listSuggestions,
  type FeedDetail,
  type StoryList,
} from "@/lib/services";
import { nowMs } from "@/lib/time";

export async function generateMetadata({ params }: PageProps<"/f/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const feed = await loadActiveFeed(slug);
  return feed ? { title: feed.name } : {};
}

/** At most this many stories feed the topic chips and the alert search when the view is filtered. */
const SIDE_LIST_LIMIT = 200;

function BackfillLine({ backfill }: { backfill: StoryList["backfill"] }) {
  if (!backfill) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      <Icon name="spinner" size={14} className="animate-spin motion-reduce:animate-none" />
      <span>{backfillText(backfill)}</span>
    </p>
  );
}

type Suggestions = Awaited<ReturnType<typeof listSuggestions>>;

/** At most this many starter suggestions show in an empty state. */
const MAX_SUGGESTIONS = 6;

/** The starter suggestions of §12 that are not in the directory yet, each with "Add" (every empty state). */
function StarterSuggestions({ feed, suggestions, name }: { feed: FeedDetail; suggestions: Suggestions; name: string | null }) {
  if (suggestions.length === 0) return null;
  const shown = suggestions.slice(0, MAX_SUGGESTIONS);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium text-fg">Add sources to this feed</h3>
      <SuggestionList
        feedSlug={feed.slug}
        name={name}
        suggestions={shown.map((s) => ({ name: s.name, type: s.type, why: s.why }))}
      />
      <Link href={`/sources/new?feed=${encodeURIComponent(feed.slug)}`} className="self-start text-sm text-accent">
        {suggestions.length > MAX_SUGGESTIONS
          ? `${suggestions.length - MAX_SUGGESTIONS} more ${suggestions.length - MAX_SUGGESTIONS === 1 ? "suggestion" : "suggestions"} and other ways to add a source`
          : "Other ways to add a source"}
      </Link>
    </div>
  );
}

/** The sources of the feed that bring no items, with the reason: it explains an empty feed (§13). */
function SourceProblems({ problems }: { problems: FeedSourceProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-fg">
        {problems.length === 1 ? "A source of this feed has a problem" : "Sources of this feed with a problem"}
      </h3>
      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
        {problems.map((p) => (
          <li key={p.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
            <Link href={`/sources/${p.id}`} className="font-medium break-words text-fg underline-offset-2 hover:underline">
              {p.name}
            </Link>
            <span className="break-words text-muted">{p.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What an empty feed with sources shows under the empty state: the source problems, then the suggestions. */
interface EmptyHelp {
  problems: FeedSourceProblem[];
  /** True when every source of the feed has a problem. */
  allBlocked: boolean;
  suggestions: Suggestions;
  feed: FeedDetail;
  name: string | null;
}

function EmptyHelpBlock({ help }: { help: EmptyHelp }) {
  if (help.problems.length === 0 && help.suggestions.length === 0) return null;
  return (
    <div className="flex flex-col gap-6">
      <SourceProblems problems={help.problems} />
      <StarterSuggestions feed={help.feed} suggestions={help.suggestions} name={help.name} />
    </div>
  );
}

async function loadEmptyHelp(feed: FeedDetail, name: string | null): Promise<EmptyHelp> {
  const [links, suggestions] = await Promise.all([listFeedSources(feed.id), listSuggestions(feed.slug)]);
  const { problems, all } = feedSourceProblems(links);
  return { problems, allBlocked: all, suggestions, feed, name };
}

function NoSources({ feed, suggestions, name }: { feed: FeedDetail; suggestions: Suggestions; name: string | null }) {
  const slug = encodeURIComponent(feed.slug);
  return (
    <EmptyState
      icon="inbox"
      title="This feed has no sources yet"
      description={
        <p>
          Choose the sources that this feed follows. A source in the shared directory can be in several feeds, and each
          feed applies its own filters.
        </p>
      }
      actions={
        <>
          <LinkButton href={`/sources/new?feed=${slug}`} variant="primary" icon="add">
            Add a source
          </LinkButton>
          <LinkButton href={`/f/${slug}/settings/sources`} variant="secondary">
            Choose from the directory
          </LinkButton>
        </>
      }
    >
      <StarterSuggestions feed={feed} suggestions={suggestions} name={name} />
    </EmptyState>
  );
}

function NoStoriesYet({
  list,
  now,
  settingsHref,
  help,
}: {
  list: StoryList;
  now: number;
  settingsHref: string;
  help: EmptyHelp;
}) {
  return (
    <EmptyState
      icon="clock"
      title="No stories yet"
      description={
        <div className="flex flex-col gap-1">
          <p>
            {help.allBlocked ? (
              "No source of this feed can bring items now. The list below says why."
            ) : (
              <>
                The worker checks the sources.{" "}
                {list.lastCheckAt ? (
                  <RelativeTime prefix="Last check:" at={list.lastCheckAt} now={now} />
                ) : (
                  "No source of this feed was checked yet."
                )}
              </>
            )}
          </p>
          {list.pendingItems > 0 ? (
            <p>{countLabel(list.pendingItems, "item waits", "items wait")} for the model.</p>
          ) : null}
        </div>
      }
      actions={
        <LinkButton href={settingsHref} variant="secondary" icon="settings">
          Sources of this feed
        </LinkButton>
      }
    >
      <div className="flex flex-col gap-6">
        {list.backfill ? (
          <div className="flex justify-center">
            <BackfillLine backfill={list.backfill} />
          </div>
        ) : null}
        <EmptyHelpBlock help={help} />
      </div>
    </EmptyState>
  );
}

function Controls({ slug, query, topics }: { slug: string; query: FeedQuery; topics: ReturnType<typeof collectTopics> }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl
          label="Time window"
          labelHidden
          size="sm"
          value={query.window}
          options={FEED_WINDOWS.map((w) => ({ value: w, label: WINDOW_LABELS[w], href: feedHref(slug, query, { window: w }) }))}
        />
        <SegmentedControl
          label="Sort"
          labelHidden
          size="sm"
          value={query.sort}
          options={FEED_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s], href: feedHref(slug, query, { sort: s }) }))}
        />
      </div>
      {topics.length > 0 ? (
        <nav aria-label="Topics">
          <ul className="flex flex-wrap gap-1.5">
            <li>
              <ChipLink href={feedHref(slug, query, { topic: null })} selected={query.topic === null}>
                All topics
              </ChipLink>
            </li>
            {topics.map((t) => (
              <li key={t.slug}>
                <ChipLink href={feedHref(slug, query, { topic: t.slug })} selected={query.topic === t.slug}>
                  {t.name}
                </ChipLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

function CountLine({ slug, query, list }: { slug: string; query: FeedQuery; list: StoryList }) {
  const visible = countLabel(list.visibleCount, "story", "stories");
  const filtered = `${list.filteredCount} filtered out`;
  if (query.filtered) {
    return (
      <p className="text-sm text-muted">
        <span className="font-medium text-fg">{filtered}</span>
        {" · "}
        <Link href={feedHref(slug, query, { filtered: false })} className="text-accent">
          Back to the {visible}
        </Link>
      </p>
    );
  }
  return (
    <p className="text-sm text-muted">
      <span className="font-medium text-fg">{visible}</span>
      {" · "}
      {list.filteredCount > 0 ? (
        <Link href={feedHref(slug, query, { filtered: true })} className="text-accent">
          {filtered}
        </Link>
      ) : (
        filtered
      )}
    </p>
  );
}

function EmptyView({ slug, query, list, help }: { slug: string; query: FeedQuery; list: StoryList; help: EmptyHelp | null }) {
  const wider = widerWindow(query.window);
  if (query.filtered) {
    return (
      <p className="py-8 text-center text-muted">
        {query.topic ? "No filtered-out story has this topic in this window." : "Nothing is filtered out in this window."}
      </p>
    );
  }
  if (query.topic) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-muted">No visible story has this topic in this window.</p>
        <LinkButton href={feedHref(slug, query, { topic: null })} size="sm">
          Show all topics
        </LinkButton>
      </div>
    );
  }
  return (
    <EmptyState
      icon="search"
      title="Nothing in this window"
      description={
        <p>
          {list.filteredCount > 0
            ? `No story of this window passes the filters of this feed. ${list.filteredCount} filtered out.`
            : "The feed has no story from this period."}
        </p>
      }
      actions={
        <>
          {wider ? (
            <LinkButton href={feedHref(slug, query, { window: wider })} variant="primary">
              Show the last {WINDOW_LABELS[wider]}
            </LinkButton>
          ) : null}
          {list.filteredCount > 0 ? (
            <LinkButton href={feedHref(slug, query, { filtered: true })} variant="secondary">
              See the stories that are filtered out
            </LinkButton>
          ) : null}
        </>
      }
    >
      {help ? <EmptyHelpBlock help={help} /> : null}
    </EmptyState>
  );
}

/** The feed page (§4.1): the ranked stories of one feed. */
export default async function FeedPage({ params, searchParams }: PageProps<"/f/[slug]">) {
  const { slug } = await params;
  const feed = await loadActiveFeed(slug);
  if (!feed) notFound();
  const query = parseFeedQuery(await searchParams);
  const actor = await getActor();
  const now = nowMs();
  const settingsHref = `/f/${encodeURIComponent(feed.slug)}/settings/sources`;

  const storyArgs = { feedId: feed.id, clientId: actor.clientId, now };
  const [list, banners, digest] = await Promise.all([
    listFeedStories({
      ...storyArgs,
      window: query.window,
      sort: query.sort,
      filtered: query.filtered,
      limit: query.limit,
      ...(query.topic ? { topicSlug: query.topic } : {}),
    }),
    getBanners(feed.id),
    latestDigest(feed.id),
  ]);

  const refreshing = banners.some((b) => b.kind === "first_run") || list.pendingItems > 0 || list.backfill !== null;
  const top = (
    <>
      <h1 className="sr-only">
        {feed.name}: {query.filtered ? "stories that are filtered out" : "stories"}
      </h1>
      <AutoRefresh everyMs={15_000} active={refreshing} />
      <Banners banners={banners} exclude={["worker_down"]} />
    </>
  );

  if (feed.sourceCount === 0) {
    const suggestions = await listSuggestions(feed.slug);
    return (
      <div className="flex flex-col gap-4">
        {top}
        <NoSources feed={feed} suggestions={suggestions} name={actor.name} />
      </div>
    );
  }

  const total = list.visibleCount + list.filteredCount;
  if (total === 0) {
    const month =
      query.window === "month"
        ? list
        : await listFeedStories({ ...storyArgs, window: "month", sort: "top", filtered: false, limit: 1 });
    if (month.visibleCount + month.filteredCount === 0) {
      const help = await loadEmptyHelp(feed, actor.name);
      return (
        <div className="flex flex-col gap-4">
          {top}
          <NoStoriesYet list={list} now={now} settingsHref={settingsHref} help={help} />
        </div>
      );
    }
  }

  // The topic chips come from the visible stories of the window; the alert
  // banner from the cards with a shown alert.
  const needSide = query.filtered || query.topic !== null;
  const side = needSide
    ? await listFeedStories({ ...storyArgs, window: query.window, sort: "top", filtered: false, limit: SIDE_LIST_LIMIT })
    : list;
  const topics = collectTopics(side.stories, query.topic);
  let alerts = collectAlerts([list.stories, side.stories], feed.alertIds);
  let hiddenAlertIds: number[] = [];
  if (!allAlertsFound(alerts, feed.alertIds)) {
    const week = await listFeedStories({ ...storyArgs, window: "week", sort: "top", filtered: false, limit: SIDE_LIST_LIMIT });
    alerts = collectAlerts([list.stories, side.stories, week.stories], feed.alertIds);
    // An alert with no visible story in the full week list: this browser's vote hid its story.
    hiddenAlertIds = alertsHiddenForMe(alerts, feed.alertIds, !week.hasMore);
  }
  const emptyHelp =
    list.stories.length === 0 && !query.filtered && !query.topic ? await loadEmptyHelp(feed, actor.name) : null;

  return (
    <div className="flex flex-col gap-4">
      {top}
      {alerts.length > 0 ? <AlertBanner feedSlug={feed.slug} alerts={alerts} /> : null}
      {hiddenAlertIds.length > 0 ? <DismissHiddenAlerts ids={hiddenAlertIds} /> : null}
      {digest ? (
        <LatestDigestLink
          feedId={feed.id}
          href={`/f/${encodeURIComponent(feed.slug)}/digests/${digest.id}`}
          title={digest.title}
          createdAt={digest.createdAt}
        />
      ) : null}
      <Controls slug={feed.slug} query={query} topics={topics} />
      <div className="flex flex-col gap-1">
        <CountLine slug={feed.slug} query={query} list={list} />
        <BackfillLine backfill={list.backfill} />
      </div>
      {list.stories.length === 0 ? (
        <EmptyView slug={feed.slug} query={query} list={list} help={emptyHelp} />
      ) : (
        // A new key for each view (window, sort, topic, list, limit): a navigation clears the Undo lines.
        <FeedStoryList
          key={feedHref(feed.slug, query)}
          feedSlug={feed.slug}
          items={list.stories.map((card) => ({
            storyId: card.storyId,
            headline: card.headline,
            card: <StoryCard card={card} feedSlug={feed.slug} now={now} mode={query.filtered ? "filtered" : "list"} />,
          }))}
        />
      )}
      {list.hasMore ? (
        <div className="flex justify-center pt-2">
          <LinkButton href={feedHref(feed.slug, query, { limit: query.limit + LIMIT_STEP })} scroll={false} icon="chevronDown">
            Show more
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}
