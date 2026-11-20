import { Fragment, type ReactNode } from "react";

import { Badge, Chip, RelativeTime } from "@/components/ui";
import type { StoryCard } from "@/lib/services/types";
import { STORY_CATEGORY_LABELS } from "@/lib/types";

import { sourceNames } from "./format";

/** At most this many topic chips on the meta line (§4.1). */
const MAX_TOPICS = 2;

/**
 * The meta line of a story (§4.1 item 1): ALERT, up to 2 topics, the
 * category, the relative time, the source names, and the show-notes label.
 */
export function StoryMeta({ card, now, showAlert = true }: { card: StoryCard; now: number; showAlert?: boolean }) {
  const { shown, more } = sourceNames(card.sources);
  const textItems: ReactNode[] = [
    <span key="category">{STORY_CATEGORY_LABELS[card.category]}</span>,
    <RelativeTime key="time" at={card.freshAt} now={now} />,
  ];
  if (shown.length > 0) {
    textItems.push(
      <span key="sources" className="min-w-0">
        <span className="sr-only">Sources: </span>
        {shown.map((s) => s.name).join(", ")}
        {more > 0 ? <span title={card.sources.slice(2).map((s) => s.name).join(", ")}>{` +${more}`}</span> : null}
      </span>,
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      {showAlert && card.alert ? (
        <Badge tone="alert" icon="alert" strong>
          Alert
        </Badge>
      ) : null}
      {card.topics.slice(0, MAX_TOPICS).map((topic) => (
        <Chip key={topic.id}>{topic.name}</Chip>
      ))}
      {textItems.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden="true" className="text-border-strong">
              ·
            </span>
          ) : null}
          {item}
        </Fragment>
      ))}
      {card.basis === "show_notes" ? (
        <Badge tone="neutral" icon="info">
          From the show notes only
        </Badge>
      ) : null}
    </div>
  );
}
