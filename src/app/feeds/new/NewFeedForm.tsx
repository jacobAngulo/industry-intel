"use client";

import { useActionState, useEffect, useRef } from "react";

import { Banner, Field, Input, SubmitButton, fieldDescribedBy } from "@/components/ui";
import { LIMITS } from "@/lib/types";

import { createFeedAction, type NewFeedState } from "./actions";

/** The form of /feeds/new: name and purpose. */
export function NewFeedForm() {
  const [state, formAction, pending] = useActionState<NewFeedState | null, FormData>(createFeedAction, null);
  const result = state?.result ?? null;
  const errors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  const formError = result && !result.ok && !errors.name && !errors.purpose ? result.message : null;
  const nameRef = useRef<HTMLInputElement>(null);
  const purposeRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);

  // Focus the first field with an error, or the form message, after a failed submit.
  useEffect(() => {
    if (!result || result.ok) return;
    if (result.fieldErrors?.name) nameRef.current?.focus();
    else if (result.fieldErrors?.purpose) purposeRef.current?.focus();
    else bannerRef.current?.focus();
  }, [result]);

  return (
    <form action={formAction} noValidate className="flex max-w-xl flex-col gap-5">
      {formError ? (
        <div ref={bannerRef} tabIndex={-1} role="alert" className="outline-none">
          <Banner tone={result && !result.ok && result.code === "limit" ? "warning" : "alert"}>{formError}</Banner>
        </div>
      ) : null}
      <Field id="feed-name" label="Name" error={errors.name ?? null} hint="For example: Security Watch.">
        <Input
          ref={nameRef}
          id="feed-name"
          name="name"
          defaultValue={state?.values.name ?? ""}
          required
          maxLength={LIMITS.name}
          autoComplete="off"
          invalid={!!errors.name}
          aria-describedby={fieldDescribedBy("feed-name", { hint: true, error: errors.name })}
        />
      </Field>
      <Field
        id="feed-purpose"
        label="Purpose"
        optional
        error={errors.purpose ?? null}
        hint="One line: what this feed is for. The model reads it when it judges stories."
      >
        <Input
          ref={purposeRef}
          id="feed-purpose"
          name="purpose"
          defaultValue={state?.values.purpose ?? ""}
          maxLength={LIMITS.oneLine}
          autoComplete="off"
          invalid={!!errors.purpose}
          aria-describedby={fieldDescribedBy("feed-purpose", { hint: true, error: errors.purpose })}
        />
      </Field>
      <div>
        <SubmitButton pending={pending} pendingLabel="Creating the feed" icon="add">
          Create feed
        </SubmitButton>
      </div>
    </form>
  );
}
