"use client";

import { useActionState } from "react";

import { Field, SubmitButton, Textarea, fieldDescribedBy } from "@/components/ui";
import type { ActionResult } from "@/lib/services/types";

import { submitAccessRequestAction } from "./actions";

export function AccessRequestForm({ maxLength, label }: { maxLength: number; label: string }) {
  const [result, formAction, pending] = useActionState<ActionResult<null> | null, FormData>(submitAccessRequestAction, null);
  const error = result && !result.ok ? (result.fieldErrors?.note ?? result.message) : null;
  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <Field id="access-note" label="Who are you, and what do you want to follow?" optional error={error}>
        <Textarea
          id="access-note"
          name="note"
          rows={3}
          maxLength={maxLength}
          invalid={!!error}
          aria-describedby={fieldDescribedBy("access-note", { error })}
        />
      </Field>
      <div>
        <SubmitButton pending={pending} pendingLabel="Sending">
          {label}
        </SubmitButton>
      </div>
    </form>
  );
}
