"use client";

import { useRef, useState } from "react";

import { deleteFeedAction, restoreFeedAction } from "@/app/settings/actions";
import { Button, Dialog } from "@/components/ui";

import { useSave } from "./use-save";

export interface ArchivedFeed {
  id: number;
  name: string;
  purpose: string;
}

/** §4.9 Archived feeds: restore, or delete for ever (with a confirmation). */
export function ArchivedFeeds({ feeds, canDelete }: { feeds: ArchivedFeed[]; canDelete: boolean }) {
  const [done, setDone] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  return (
    <div className="flex flex-col gap-3">
      <p ref={statusRef} role="status" tabIndex={-1} className="text-sm text-success empty:hidden">
        {done}
      </p>
      {feeds.length === 0 ? (
        <p className="text-sm text-muted">No archived feed. A feed that you archive shows here, and you can restore it.</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {feeds.map((feed) => (
            <ArchivedFeedRow
              key={feed.id}
              feed={feed}
              canDelete={canDelete}
              onDone={(text) => {
                setDone(text);
                // The row goes away: move the focus to the message.
                requestAnimationFrame(() => statusRef.current?.focus());
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ArchivedFeedRow({
  feed,
  canDelete,
  onDone,
}: {
  feed: ArchivedFeed;
  canDelete: boolean;
  onDone: (text: string) => void;
}) {
  const restore = useSave(restoreFeedAction);
  const remove = useSave(deleteFeedAction);
  const [confirm, setConfirm] = useState(false);
  const failure = restore.failure?.message ?? null;

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium text-fg">{feed.name}</p>
        {feed.purpose ? <p className="text-sm text-muted">{feed.purpose}</p> : null}
        {failure ? (
          <p role="alert" className="text-sm text-alert">
            {failure}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          size="sm"
          icon="undo"
          pending={restore.pending}
          onClick={() => void restore.run({ feedId: feed.id }, () => onDone(`${feed.name} is back in the feed tabs.`))}
        >
          Restore<span className="sr-only"> {feed.name}</span>
        </Button>
        {canDelete ? (
          <Button size="sm" variant="danger" icon="delete" onClick={() => setConfirm(true)}>
            Delete for ever<span className="sr-only">: {feed.name}</span>
          </Button>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Delete ${feed.name} for ever?`}
        description="The feed's settings, judgements, digests, alerts, votes, and analyses go. The sources and the stories stay for the other feeds. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={remove.pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="delete"
              pending={remove.pending}
              pendingLabel="Deleting"
              onClick={() =>
                void remove.run({ feedId: feed.id }, () => {
                  setConfirm(false);
                  onDone(`${feed.name} is deleted.`);
                })
              }
            >
              Delete for ever
            </Button>
          </>
        }
      >
        {remove.failure ? (
          <p role="alert" className="text-sm text-alert">
            {remove.failure.message}
          </p>
        ) : null}
      </Dialog>
    </li>
  );
}
