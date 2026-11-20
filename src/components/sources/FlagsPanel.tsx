"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { flagNoisyAction, resolveFlagsAction } from "@/app/sources/actions";
import { Banner, Button, Field, Input, fieldDescribedBy } from "@/components/ui";

import { useGatedAction } from "./use-gated-action";

export interface FlagsPanelProps {
  sourceId: number;
  openFlags: number;
  name: string | null;
}

/** "Flag as noisy" (optional note) and "Resolve flags" (§4.6). */
export function FlagsPanel({ sourceId, openFlags, name }: FlagsPanelProps) {
  const id = useId();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flag = useGatedAction(name);
  const resolve = useGatedAction(name);

  const done = (text: string) => {
    setError(null);
    setMessage(text);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <form
        noValidate
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          flag.run(
            () => flagNoisyAction({ id: sourceId, note }),
            (result) => {
              if (!result.ok) {
                setError(result.fieldErrors?.note ?? result.message);
                return;
              }
              setNote("");
              done(result.message ?? "Flagged.");
            },
          );
        }}
      >
        <Field
          id={`${id}-note`}
          label="Note"
          optional
          hint="What is noisy about it, for example: mostly event announcements."
          className="flex-1"
        >
          <Input
            id={`${id}-note`}
            value={note}
            maxLength={300}
            aria-describedby={fieldDescribedBy(`${id}-note`, { hint: true })}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Button type="submit" icon="flag" pending={flag.pending} pendingLabel="Flagging" className="sm:mb-7">
          Flag as noisy
        </Button>
      </form>
      {openFlags > 0 ? (
        <div>
          <Button
            variant="secondary"
            icon="check"
            pending={resolve.pending}
            pendingLabel="Resolving"
            onClick={() => {
              setMessage(null);
              resolve.run(
                () => resolveFlagsAction({ id: sourceId }),
                (result) => (result.ok ? done(result.message ?? "Resolved.") : setError(result.message)),
              );
            }}
          >
            Resolve {openFlags === 1 ? "the open flag" : `all ${openFlags} open flags`}
          </Button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm text-success">
        {message ?? ""}
      </p>
      {error ? (
        <div role="alert">
          <Banner tone="alert">{error}</Banner>
        </div>
      ) : null}
      {flag.dialog}
      {resolve.dialog}
    </div>
  );
}
