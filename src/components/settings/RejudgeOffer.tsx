"use client";

import { useState } from "react";

import { requestRejudgeAction } from "@/app/settings/actions";
import { Button, Card } from "@/components/ui";

import { modelCalls, type RejudgeEstimate } from "./helpers";
import { useSave } from "./use-save";

export interface RejudgeOfferProps {
  /** One estimate (a feed setting) or one for each active feed (the shared feed profile). */
  estimates: RejudgeEstimate[];
  /** Limits the re-judge to the stories of one source (a change of Follow / Ignore). */
  sourceId?: number;
  /** Hides the offer ("Not now"). */
  onDismiss: () => void;
}

/**
 * The offer after the save of a judge-time setting (§4.8, §8.4):
 * "This applies to new stories. Re-judge the last 7 days? (about N model calls)".
 * The progress line of the page shows the request after the click.
 */
export function RejudgeOffer({ estimates, sourceId, onDismiss }: RejudgeOfferProps) {
  const save = useSave(requestRejudgeAction);
  const [requested, setRequested] = useState<number[]>([]);
  const total = estimates.reduce((sum, e) => sum + e.calls, 0);
  const open = estimates.filter((e) => e.calls > 0 && !requested.includes(e.feedId));

  const ask = (feedIds: number[]) => {
    void save.run(sourceId === undefined ? { feedIds } : { feedIds, sourceId }, () =>
      setRequested((prev) => [...prev, ...feedIds]),
    );
  };

  let body;
  if (total === 0) {
    body = <p className="text-sm">This applies to new stories. No story of the last 7 days needs a re-judge.</p>;
  } else if (open.length === 0) {
    body = <p className="text-sm">Re-judge requested. The progress line on this page shows how far it is.</p>;
  } else if (estimates.length === 1 && estimates[0]) {
    const only = estimates[0];
    body = (
      <>
        <p className="text-sm">
          This applies to new stories. Re-judge the last 7 days? (about {modelCalls(only.calls)})
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon="refresh" pending={save.pending} onClick={() => ask([only.feedId])}>
            Re-judge the last 7 days
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-sm">
          This applies to new stories in every feed. Re-judge the last 7 days? (about {modelCalls(total)} in all)
        </p>
        <ul className="flex flex-col divide-y divide-border text-sm">
          {estimates.map((e) => (
            <li key={e.feedId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                <span className="font-medium">{e.feedName}</span>
                <span className="text-muted"> · about {modelCalls(e.calls)}</span>
              </span>
              {requested.includes(e.feedId) ? (
                <span className="text-muted">Requested</span>
              ) : e.calls > 0 ? (
                <Button size="sm" variant="secondary" disabled={save.pending} onClick={() => ask([e.feedId])}>
                  Re-judge <span className="sr-only">{e.feedName}</span>
                </Button>
              ) : (
                <span className="text-muted">Nothing to re-judge</span>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            icon="refresh"
            pending={save.pending}
            onClick={() => ask(open.map((e) => e.feedId))}
          >
            Re-judge all feeds
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </>
    );
  }

  return (
    <Card variant="inset" padding="sm" className="mt-4 flex flex-col gap-3" aria-live="polite">
      {body}
      {save.failure ? (
        <p role="alert" className="text-sm text-alert">
          {save.failure.message}
        </p>
      ) : null}
    </Card>
  );
}
