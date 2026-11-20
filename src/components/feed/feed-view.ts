// Pure helpers of the feed page: the topic chips, the alert banner rows, and
// the sources with a problem (empty states).
import { sourceProblem } from "@/components/sources/labels";
import type { SourceRow, StoryCard, StoryList } from "@/lib/services/types";

import type { AlertItem } from "./AlertBanner";

export interface TopicChip {
  slug: string;
  name: string;
  /** The number of stories with this topic in the given cards. */
  count: number;
}

/**
 * The topics of the given (visible) stories, most stories first, then by
 * name. The selected topic is always in the list, also when no card has it.
 */
export function collectTopics(cards: readonly StoryCard[], selected: string | null): TopicChip[] {
  const bySlug = new Map<string, TopicChip>();
  for (const card of cards) {
    for (const topic of card.topics) {
      const chip = bySlug.get(topic.slug);
      if (chip) chip.count += 1;
      else bySlug.set(topic.slug, { slug: topic.slug, name: topic.name, count: 1 });
    }
  }
  if (selected && !bySlug.has(selected)) bySlug.set(selected, { slug: selected, name: selected, count: 0 });
  return [...bySlug.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * The alert rows: the cards with a shown alert whose id is in `alertIds`
 * (the visible alerts of the feed now), one row for each alert, in card order.
 */
export function collectAlerts(cardLists: ReadonlyArray<readonly StoryCard[]>, alertIds: readonly number[]): AlertItem[] {
  const wanted = new Set(alertIds);
  const seen = new Set<number>();
  const rows: AlertItem[] = [];
  for (const cards of cardLists) {
    for (const card of cards) {
      const id = card.alert?.id;
      if (id === undefined || !wanted.has(id) || seen.has(id)) continue;
      seen.add(id);
      rows.push({ alertId: id, storyId: card.storyId, headline: card.headline });
    }
  }
  return rows;
}

/** True when every alert id has a row. */
export function allAlertsFound(rows: readonly AlertItem[], alertIds: readonly number[]): boolean {
  const found = new Set(rows.map((row) => row.alertId));
  return alertIds.every((id) => found.has(id));
}

/**
 * The visible alerts of the feed (`alertIds`) that have no row although the
 * search covered every visible story of the window (`complete`): their
 * stories are hidden for this browser (its own negative vote), so nothing on
 * the page can dismiss them (§9.3). Empty when the search was not complete.
 */
export function alertsHiddenForMe(rows: readonly AlertItem[], alertIds: readonly number[], complete: boolean): number[] {
  if (!complete) return [];
  const found = new Set(rows.map((row) => row.alertId));
  return alertIds.filter((id) => !found.has(id));
}

export interface FeedSourceProblem {
  id: number;
  name: string;
  /** Why the source brings no items, in one line. */
  reason: string;
}

/**
 * The sources of the feed that bring no items, with the reason (§13), and
 * `all`: true when every source of the feed has such a problem.
 */
export function feedSourceProblems(
  links: ReadonlyArray<{ source: SourceRow; included: boolean }>,
): { problems: FeedSourceProblem[]; all: boolean } {
  const included = links.filter((link) => link.included);
  const problems: FeedSourceProblem[] = [];
  for (const { source } of included) {
    const reason = sourceProblem(source);
    if (reason) problems.push({ id: source.id, name: source.name, reason });
  }
  return { problems, all: included.length > 0 && problems.length === included.length };
}

/** The progress line of an open re-judge request of the feed (§7.7 backfill, or a re-judge of the feed). */
export function backfillText(backfill: NonNullable<StoryList["backfill"]>): string {
  const progress = `${backfill.done} of ${backfill.total} done`;
  return backfill.kind === "rejudge"
    ? `Re-judging recent stories: ${progress}`
    : `Recent stories of the new sources are in the queue: ${progress}`;
}
