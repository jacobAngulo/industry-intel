"use client";

import { useId, useState, useTransition } from "react";

import { flagSourceAction } from "@/app/f/[slug]/actions";
import { useNameGate } from "@/components/NameGate";
import { Button, Dialog, Field, Icon, Textarea, fieldDescribedBy } from "@/components/ui";
import { LIMITS } from "@/lib/types";

/**
 * The text button "Flag source as noisy" of a story item (§4.2), with an
 * optional note in a small dialog. Needs a display name.
 */
export function FlagSourceButton({
  feedSlug,
  storyId,
  sourceId,
  sourceName,
  name,
}: {
  feedSlug: string;
  storyId: number;
  sourceId: number;
  sourceName: string;
  name: string | null;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const { ensureName, dialog } = useNameGate(name);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState(false);
  const [pending, startTransition] = useTransition();

  const start = async () => {
    if (!(await ensureName())) return;
    setError(null);
    setOpen(true);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await flagSourceAction({ feedSlug, storyId, sourceId, note });
        if (result.ok) {
          setFlagged(true);
          setOpen(false);
          setNote("");
        } else {
          setError(result.fieldErrors?.note ?? result.message);
        }
      } catch {
        setError("The flag was not saved. Check the connection and try again.");
      }
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {!flagged ? (
          <button
            type="button"
            onClick={() => void start()}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-control text-sm text-muted underline decoration-border-strong underline-offset-2 hover:text-fg sm:min-h-8"
          >
            <Icon name="flag" size={14} />
            Flag source as noisy<span className="sr-only">: {sourceName}</span>
          </button>
        ) : null}
        <span role="status" className="text-sm">
          {flagged ? (
            <span className="inline-flex items-center gap-1.5 text-success">
              <Icon name="check" size={14} />
              Flagged as noisy. The source owner sees it on the source page.
            </span>
          ) : null}
        </span>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Flag source as noisy"
        description={`${sourceName} brings too many stories that do not help. The flag shows on the source page for its owner.`}
        size="sm"
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          <Field id={noteId} label="Note" optional error={error} hint="For example: mostly marketing posts.">
            <Textarea
              id={noteId}
              name="note"
              rows={3}
              maxLength={LIMITS.oneLine}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              invalid={!!error}
              aria-describedby={fieldDescribedBy(noteId, { hint: true, error })}
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon="flag" pending={pending} pendingLabel="Saving">
              Flag as noisy
            </Button>
          </div>
        </form>
      </Dialog>
      {dialog}
    </>
  );
}
