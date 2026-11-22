"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { checkNowAction, setPausedAction } from "@/app/sources/actions";
import { Button } from "@/components/ui";

import { DeleteSourceButton } from "./DeleteSourceButton";
import { useAction } from "./use-action";

export interface SourceHeaderActionsProps {
  sourceId: number;
  sourceName: string;
  paused: boolean;
  checkRequested: boolean;
  /** All items of the source and the stories that only it has (for the delete dialog). */
  itemCount: number;
  soleStoryCount: number;
}

/** Check now, Pause / Resume, and Delete (§4.6). */
export function SourceHeaderActions({
  sourceId,
  sourceName,
  paused,
  checkRequested,
  itemCount,
  soleStoryCount,
}: SourceHeaderActionsProps) {
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const check = useAction();
  const pause = useAction();

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon="refresh"
          pending={check.pending}
          pendingLabel="Asking for a check"
          disabled={checkRequested || paused}
          title={paused ? "Resume the source first." : checkRequested ? "A check is requested already." : undefined}
          onClick={() =>
            check.run(
              () => checkNowAction({ id: sourceId }),
              (result) => {
                setMessage({ text: result.message ?? (result.ok ? "A check is requested." : ""), error: !result.ok });
                if (result.ok) router.refresh();
              },
            )
          }
        >
          {checkRequested ? "Check requested" : "Check now"}
        </Button>
        <Button
          icon={paused ? "resume" : "pause"}
          pending={pause.pending}
          onClick={() =>
            pause.run(
              () => setPausedAction({ id: sourceId, paused: !paused }),
              (result) => {
                setMessage({ text: result.message ?? "", error: !result.ok });
                if (result.ok) router.refresh();
              },
            )
          }
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        <DeleteSourceButton
          sourceId={sourceId}
          sourceName={sourceName}
         
          itemCount={itemCount}
          soleStoryCount={soleStoryCount}
          redirectTo="/sources"
        />
      </div>
      <p role="status" aria-live="polite" className={message?.error ? "text-sm text-alert" : "text-sm text-muted"}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
