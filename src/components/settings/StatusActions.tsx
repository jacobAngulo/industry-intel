"use client";

import { useState } from "react";

import { checkAllDueAction, retryFailedAction } from "@/app/status/actions";
import { Button } from "@/components/ui";

import { useSave } from "./use-save";

/** The two buttons of the status page (§4.10), each with its result message. */
export function StatusActions({ failedItems }: { failedItems: number }) {
  const check = useSave(checkAllDueAction);
  const retry = useSave(retryFailedAction);
  const [checkText, setCheckText] = useState<string | null>(null);
  const [retryText, setRetryText] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div>
          <Button
            icon="refresh"
            pending={check.pending}
            onClick={() => {
              setCheckText(null);
              void check.run(undefined, ({ count }) =>
                setCheckText(
                  count === 0
                    ? "No active source to check."
                    : `Asked for a check of ${count} ${count === 1 ? "source" : "sources"}. The worker checks them in the next minutes.`,
                ),
              );
            }}
          >
            Check all sources now
          </Button>
        </div>
        <p className="text-sm text-muted">
          This reads every active source now, also X and web search sources, which use paid quota.
        </p>
        <p role="status" className="text-sm empty:hidden">
          {checkText}
        </p>
        {check.failure ? (
          <p role="alert" className="text-sm text-alert">
            {check.failure.message}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <div>
          <Button
            icon="undo"
            pending={retry.pending}
            onClick={() => {
              setRetryText(null);
              void retry.run(undefined, ({ count }) =>
                setRetryText(
                  count === 0
                    ? "No failed item. Nothing changed."
                    : `Put ${count} failed ${count === 1 ? "item" : "items"} back in the queue for the model.`,
                ),
              );
            }}
          >
            Retry failed items
          </Button>
        </div>
        <p className="text-sm text-muted">
          {failedItems === 0
            ? "No item failed."
            : `${failedItems} ${failedItems === 1 ? "item" : "items"} failed 5 times. A retry starts them again from attempt 0.`}
        </p>
        <p role="status" className="text-sm empty:hidden">
          {retryText}
        </p>
        {retry.failure ? (
          <p role="alert" className="text-sm text-alert">
            {retry.failure.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
