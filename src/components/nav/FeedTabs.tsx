"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { Icon, NavTabs, cn, type NavTabItem } from "@/components/ui";

import { hasUndismissedAlerts } from "./dismissed-alerts";
import { useDismissedAlerts } from "./use-dismissed-alerts";

export interface FeedTab {
  slug: string;
  name: string;
  /** Visible alert ids now (FeedSummary.alertIds). */
  alertIds: number[];
}

export interface FeedTabsProps {
  /** Active feeds in `position` order. */
  feeds: FeedTab[];
  className?: string;
}

/** A small dot on a tab, with text for screen readers. */
function AlertDot() {
  return (
    <>
      <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full bg-alert" />
      <span className="sr-only">(new alert)</span>
    </>
  );
}

/**
 * The feed tabs of the top navigation (§3): one tab per active feed, the
 * current feed marked, a dot when the feed has alerts that this browser did
 * not dismiss, and "+ New feed". The tabs scroll sideways at phone width.
 */
export function FeedTabs({ feeds, className }: FeedTabsProps) {
  const dismissed = useDismissedAlerts();
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  // Keep the current tab in view when the tabs scroll sideways.
  useEffect(() => {
    const current = ref.current?.querySelector<HTMLElement>('[aria-current="page"]');
    current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  const items: NavTabItem[] = feeds.map((f) => ({
    href: `/f/${encodeURIComponent(f.slug)}`,
    label: f.name,
    // Before hydration the dismissed list is unknown: no dot until then.
    after: dismissed !== null && hasUndismissedAlerts(f.alertIds, dismissed) ? <AlertDot /> : null,
  }));
  items.push({
    href: "/feeds/new",
    label: (
      <>
        <Icon name="add" size={14} />
        New feed
      </>
    ),
    match: "exact",
  });

  return (
    <div ref={ref} className={cn("min-w-0", className)}>
      <NavTabs label="Feeds" items={items} />
    </div>
  );
}
