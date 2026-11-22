import Link from "next/link";

import { FeedTabs, type FeedTab } from "./FeedTabs";
import { SiteLinks } from "./SiteLinks";

export interface TopNavProps {
  /** Active feeds in `position` order. */
  feeds: FeedTab[];
  /** The name of the signed-in person. */
  name: string;
}

/**
 * The top navigation of every page (§3): the product name, the feed tabs,
 * "+ New feed", and on the right Sources, Settings, Status, and the signed-in
 * person. Wide screens: one row. Phone width: the name and a menu on the first
 * row, the feed tabs (scrolling sideways) on the second row.
 */
export function TopNav({ feeds, name }: TopNavProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-6 px-4 sm:px-6">
        <Link
          href="/"
          className="order-1 inline-flex min-h-12 items-center font-serif text-lg font-semibold tracking-tight text-fg no-underline"
        >
          Industry Intel
        </Link>
        <FeedTabs feeds={feeds} className="order-3 -mx-2 w-[calc(100%+1rem)] lg:order-2 lg:mx-0 lg:w-auto lg:flex-1" />
        <SiteLinks name={name} className="order-2 ml-auto lg:order-3 lg:ml-0" />
      </div>
    </header>
  );
}

export type { FeedTab };
