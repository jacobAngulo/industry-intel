"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { dismissAlerts, readDismissedAlerts, undismissedAlerts, useDismissedAlerts } from "@/components/nav";
import { Banner, Button } from "@/components/ui";

export interface AlertItem {
  alertId: number;
  storyId: number;
  headline: string;
}

/**
 * The alert banner of the feed page (§9.3): the stories with a visible alert
 * that this browser did not dismiss. Each has its headline as a link and
 * "Dismiss". Nothing shows before hydration (localStorage is unknown then).
 */
export function AlertBanner({ feedSlug, alerts }: { feedSlug: string; alerts: AlertItem[] }) {
  const dismissed = useDismissedAlerts();
  const [note, setNote] = useState("");
  const regionRef = useRef<HTMLDivElement>(null);

  const open =
    dismissed === null ? [] : (() => {
      const ids = new Set(undismissedAlerts(alerts.map((a) => a.alertId), dismissed));
      return alerts.filter((a) => ids.has(a.alertId));
    })();

  const dismiss = (ids: number[]) => {
    dismissAlerts(ids);
    setNote(ids.length === 1 ? "Alert dismissed." : "Alerts dismissed.");
    regionRef.current?.focus();
  };

  return (
    <div ref={regionRef} tabIndex={-1} className="outline-none">
      <p role="status" aria-live="polite" className="sr-only">
        {note}
      </p>
      {open.length > 0 ? (
        <Banner
          tone="alert"
          title={open.length === 1 ? "1 story needs attention now" : `${open.length} stories need attention now`}
          actions={
            open.length > 1 ? (
              <Button size="sm" variant="ghost" onClick={() => dismiss(open.map((a) => a.alertId))}>
                Dismiss all
              </Button>
            ) : null
          }
        >
          <ul className="mt-1 flex flex-col gap-1">
            {open.map((a) => (
              <li key={a.alertId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <Link
                  href={`/f/${encodeURIComponent(feedSlug)}/story/${a.storyId}`}
                  className="min-w-0 font-medium text-fg underline decoration-alert/40 underline-offset-2 hover:decoration-alert"
                >
                  {a.headline}
                </Link>
                <Button size="sm" variant="ghost" onClick={() => dismiss([a.alertId])}>
                  Dismiss<span className="sr-only">: {a.headline}</span>
                </Button>
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  );
}

/**
 * Dismisses, in this browser, the alerts whose stories this browser hid with
 * its own vote (§9.3): no banner row and no Dismiss button can clear them, so
 * the tab dot would stay. Renders nothing.
 */
export function DismissHiddenAlerts({ ids }: { ids: number[] }) {
  const key = ids.join(",");
  useEffect(() => {
    const wanted = key ? key.split(",").map(Number) : [];
    const open = undismissedAlerts(wanted, readDismissedAlerts());
    if (open.length > 0) dismissAlerts(open);
  }, [key]);
  return null;
}
