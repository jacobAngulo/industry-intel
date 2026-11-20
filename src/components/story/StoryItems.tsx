import Link from "next/link";

import { Icon, RelativeTime, SourceTypeIcon } from "@/components/ui";
import type { StoryItemRow } from "@/lib/services/types";
import { ITEM_KIND_LABELS, SOURCE_TYPE_LABELS } from "@/lib/types";

import { FlagSourceButton } from "./FlagSourceButton";
import { safeHttpUrl } from "./format";

/**
 * The items of a story (§4.2 "Sources"): source name and type, item title,
 * time, link, and the text of short items. Each row has "Flag source as noisy".
 */
export function StoryItems({
  items,
  feedSlug,
  storyId,
  now,
  name,
}: {
  items: StoryItemRow[];
  feedSlug: string;
  storyId: number;
  now: number;
  name: string | null;
}) {
  if (items.length === 0) {
    return <p className="text-muted">The items of this story are gone (their source was deleted).</p>;
  }
  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((item) => {
        const url = safeHttpUrl(item.url);
        const title = item.title.trim() || "(no title)";
        return (
          <li key={item.id} className="flex flex-col gap-1.5 py-4">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
              <SourceTypeIcon type={item.sourceType} size={14} />
              <Link href={`/sources/${item.sourceId}`} className="font-medium text-fg">
                {item.sourceName}
              </Link>
              <span aria-hidden="true">·</span>
              <span>{SOURCE_TYPE_LABELS[item.sourceType]}</span>
              <span aria-hidden="true">·</span>
              <span>{ITEM_KIND_LABELS[item.kind]}</span>
              <span aria-hidden="true">·</span>
              {item.publishedAt ? <RelativeTime at={item.publishedAt} now={now} /> : <span>No date</span>}
              {item.author ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{item.author}</span>
                </>
              ) : null}
            </p>
            <p className="font-medium break-words text-fg">
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-fg decoration-border-strong">
                  {title}
                  <Icon name="external" size={14} className="ml-1 inline align-[-0.1em] text-muted" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                title
              )}
            </p>
            {item.text ? <p className="text-sm leading-relaxed break-words whitespace-pre-line text-fg/90">{item.text}</p> : null}
            <FlagSourceButton
              feedSlug={feedSlug}
              storyId={storyId}
              sourceId={item.sourceId}
              sourceName={item.sourceName}
              name={name}
            />
          </li>
        );
      })}
    </ul>
  );
}
