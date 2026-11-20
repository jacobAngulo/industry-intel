import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, PageContainer, PageHeader, RelativeTime } from "@/components/ui";
import { listActivity, listFeeds, listSources, type ActivityRow } from "@/lib/services";
import { nowMs } from "@/lib/time";

export const metadata: Metadata = { title: "Recent changes" };

type EntityLink = { href: string; label: string } | null;

/** §4.10 Activity: the last 100 changes to sources, feeds, and shared settings, newest first. */
export default async function ActivityPage() {
  const [rows, feeds, sources] = await Promise.all([
    listActivity(100),
    listFeeds({ includeArchived: true }),
    listSources(),
  ]);
  const now = nowMs();
  const feedById = new Map(feeds.map((f) => [f.id, f]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  /** A link to the entity of the row while it still exists. */
  const linkOf = (row: ActivityRow): EntityLink => {
    if (row.entityId === null) return row.entityType === "settings" ? { href: "/settings", label: "Shared settings" } : null;
    if (row.entityType === "feed") {
      const feed = feedById.get(row.entityId);
      if (!feed) return null;
      return feed.archived
        ? { href: "/settings#archived-feeds", label: `${feed.name} (archived)` }
        : { href: `/f/${feed.slug}`, label: feed.name };
    }
    if (row.entityType === "source") {
      const source = sourceById.get(row.entityId);
      return source ? { href: `/sources/${source.id}`, label: source.name } : null;
    }
    if (row.entityType === "topic") return { href: "/settings#topics", label: "Topics" };
    return null;
  };

  return (
    <PageContainer>
      <PageHeader
        title="Recent changes"
        description="The last 100 changes to sources, feeds, and shared settings, newest first."
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="activity"
          title="No change yet"
          description="When somebody adds a source or changes a setting, it shows here with the name and the time."
        />
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {rows.map((row, i) => {
            const link = linkOf(row);
            return (
              <li key={`${row.at}-${i}`} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
                <div className="flex shrink-0 flex-wrap gap-x-2 text-sm text-muted sm:w-44 sm:flex-col">
                  <RelativeTime at={row.at} now={now} />
                  <span className="break-words text-fg">{row.actor}</span>
                </div>
                <div className="min-w-0 text-sm">
                  <p className="break-words text-fg">{row.summary}</p>
                  {link ? (
                    <Link href={link.href} className="text-sm">
                      Open {link.label}
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </PageContainer>
  );
}
