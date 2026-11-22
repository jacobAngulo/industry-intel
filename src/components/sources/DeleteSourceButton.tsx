"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteSourceAction } from "@/app/sources/actions";
import { Banner, Button, Dialog, type ButtonSize, type ButtonVariant } from "@/components/ui";

import { setFlash } from "./FlashMessage";
import { useAction } from "./use-action";

export interface DeleteSourceButtonProps {
  sourceId: number;
  sourceName: string;
  /** All items of the source, for the confirmation text (unknown when absent). */
  itemCount?: number;
  /** The stories that only this source has, for the confirmation text (unknown when absent). */
  soleStoryCount?: number;
  /** After the delete: go to this address (default: stay and refresh). */
  redirectTo?: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** "Delete" with a confirmation that says what goes (§4.6, §5 "Deleting a source"). */
export function DeleteSourceButton({
  sourceId,
  sourceName,
  itemCount,
  soleStoryCount,
  redirectTo,
  label = "Delete",
  variant = "danger",
  size = "md",
}: DeleteSourceButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, pending } = useAction();

  const confirm = () => {
    setError(null);
    run(
      () => deleteSourceAction({ id: sourceId }),
      (result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setFlash({ tone: "info", title: `Deleted the source "${result.data.name}".` }, { samePage: !redirectTo });
        setOpen(false);
        if (redirectTo) router.push(redirectTo);
        else router.refresh();
      },
    );
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon="delete"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {label}
        {label === "Remove" ? <span className="sr-only"> {sourceName} from the directory</span> : null}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete "${sourceName}"?`}
        description="This removes the source from the directory and from every feed. It cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="danger" icon="delete" pending={pending} pendingLabel="Deleting" onClick={confirm}>
              Delete the source
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>These go with it:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              All its items{itemCount !== undefined ? ` (${itemCount})` : null}, its check history, and its noisy
              flags.
            </li>
            <li>
              {soleStoryCount !== undefined
                ? `${soleStoryCount} ${soleStoryCount === 1 ? "story" : "stories"} that only this source had`
                : "Every story that only this source had"}
              , with their votes and analyses.
            </li>
          </ul>
          <p className="text-muted">Stories that other sources also have stay in the feeds.</p>
          {error ? (
            <div role="alert">
              <Banner tone="alert">{error}</Banner>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
