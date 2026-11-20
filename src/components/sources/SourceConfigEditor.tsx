"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { updateConfigAction } from "@/app/sources/actions";
import { Banner, Button, SavedNote } from "@/components/ui";
import type { SourceType } from "@/lib/types";

import { checkConfig, type ConfigObject } from "./config-fields";
import { SourceConfigForm } from "./SourceConfigForm";
import { useGatedAction } from "./use-gated-action";
import { errorsAt } from "./wizard-logic";

export interface SourceConfigEditorProps {
  sourceId: number;
  type: SourceType;
  config: unknown;
  identityFields: readonly string[];
  name: string | null;
}

/** The type-specific settings of a source with Save (§4.6). Identity fields are read-only. */
export function SourceConfigEditor({ sourceId, type, config, identityFields, name }: SourceConfigEditorProps) {
  const router = useRouter();
  const [value, setValue] = useState<ConfigObject>(() => (config && typeof config === "object" ? { ...(config as ConfigObject) } : {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { run, pending, dialog } = useGatedAction(name);

  const submit = () => {
    const local = checkConfig(type, value);
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) {
      setFormError("Some fields are not valid. Correct the marked fields and try again.");
      return;
    }
    run(
      () => updateConfigAction({ id: sourceId, config: value }),
      (result) => {
        if (result.ok) {
          setSavedAt(Date.now());
          router.refresh();
          return;
        }
        setErrors(errorsAt(result.fieldErrors, "config"));
        setFormError(result.message);
      },
    );
  };

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
        <SourceConfigForm
          type={type}
          value={value}
          onChange={setValue}
          mode="edit"
          errors={errors}
          identityFields={identityFields}
        />
        {formError ? (
          <div role="alert">
            <Banner tone="alert">{formError}</Banner>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving">
            Save settings
          </Button>
          <SavedNote at={savedAt} />
        </div>
      </form>
      {dialog}
    </>
  );
}
