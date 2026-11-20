"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { updateAboutAction } from "@/app/sources/actions";
import { Banner, Button, Field, Input, SavedNote, Select, fieldDescribedBy } from "@/components/ui";

import { aboutPatch, type AboutValues } from "./about-patch";
import { intervalOptions } from "./labels";
import { useGatedAction } from "./use-gated-action";

export interface SourceAboutFormProps {
  sourceId: number;
  initial: { name: string; why: string; owner: string | null; checkIntervalMinutes: number };
  typeDefaultInterval: number;
  name: string | null;
}

/** Name, why it matters, owner, and check interval of a source (§4.6). */
export function SourceAboutForm({ sourceId, initial, typeDefaultInterval, name }: SourceAboutFormProps) {
  const id = useId();
  const router = useRouter();
  const [values, setValues] = useState<AboutValues>({
    name: initial.name,
    why: initial.why,
    owner: initial.owner ?? "",
    interval: String(initial.checkIntervalMinutes),
  });
  // The values that this form saw (at load, then after each save): a save sends only the fields that differ.
  const [base, setBase] = useState<AboutValues>(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { run, pending, dialog } = useGatedAction(name);

  const set = (key: keyof AboutValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const submit = () => {
    const local: Record<string, string> = {};
    if (!values.name.trim()) local.name = "Enter a name.";
    if (!values.why.trim()) local.why = "Say why this source matters.";
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;
    const patch = aboutPatch(base, values);
    if (Object.keys(patch).length === 0) {
      setSavedAt(Date.now());
      return;
    }
    const sent = values;
    run(
      () => updateAboutAction({ id: sourceId, ...patch }),
      (result) => {
        if (result.ok) {
          setBase(sent);
          setSavedAt(Date.now());
          router.refresh();
          return;
        }
        setErrors(result.fieldErrors ?? {});
        setFormError(result.message);
      },
    );
  };

  const field = (key: string) => ({ id: `${id}-${key}`, error: errors[key] ?? null });

  return (
    <>
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field {...field("name")} label="Name">
          <Input
            id={`${id}-name`}
            value={values.name}
            maxLength={120}
            required
            invalid={!!errors.name}
            aria-describedby={fieldDescribedBy(`${id}-name`, { error: errors.name })}
            onChange={set("name")}
          />
        </Field>
        <Field
          {...field("owner")}
          label="Owner"
          optional
          hint="The person who keeps the settings of this source up to date."
        >
          <Input
            id={`${id}-owner`}
            value={values.owner}
            maxLength={120}
            invalid={!!errors.owner}
            aria-describedby={fieldDescribedBy(`${id}-owner`, { hint: true, error: errors.owner })}
            onChange={set("owner")}
          />
        </Field>
        <Field {...field("why")} label="Why it matters" className="sm:col-span-2">
          <Input
            id={`${id}-why`}
            value={values.why}
            maxLength={300}
            required
            invalid={!!errors.why}
            aria-describedby={fieldDescribedBy(`${id}-why`, { error: errors.why })}
            onChange={set("why")}
          />
        </Field>
        <Field
          id={`${id}-interval`}
          error={errors.checkIntervalMinutes ?? null}
          label="Check interval"
          hint="How often the worker asks the source for new items."
        >
          <Select
            id={`${id}-interval`}
            value={values.interval}
            options={intervalOptions(Number(values.interval), typeDefaultInterval)}
            invalid={!!errors.checkIntervalMinutes}
            aria-describedby={fieldDescribedBy(`${id}-interval`, { hint: true, error: errors.checkIntervalMinutes })}
            onChange={set("interval")}
          />
        </Field>
      </div>
      {formError ? (
        <div role="alert">
          <Banner tone="alert">{formError}</Banner>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving">
          Save
        </Button>
        <SavedNote at={savedAt} />
      </div>
    </form>
    {dialog}
    </>
  );
}
