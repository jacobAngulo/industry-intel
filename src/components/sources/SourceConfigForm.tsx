"use client";

// The type-specific settings of a source (specification §6.3, §15
// <SourceConfigForm>). The add-source flow and the source page use it.
//
// The zod schemas of src/lib/connectors/configs.ts are not imported here:
// that module imports @/lib/env, which needs Node. The form runs a light check
// (checkConfig) and the Server Action validates with the schema of the type.
import { useId, useState } from "react";

import { Banner, Field, Input, Select, Switch, fieldDescribedBy } from "@/components/ui";
import type { SourceType } from "@/lib/types";

import {
  configFields,
  listToText,
  numberFieldValue,
  setConfigValue,
  textFieldValue,
  textToList,
  variantLabel,
  variantOf,
  type ConfigField,
  type ConfigObject,
} from "./config-fields";

export interface SourceConfigFormProps {
  type: SourceType;
  value: unknown;
  onChange: (next: ConfigObject) => void;
  /** "edit": the identity fields are read-only (§4.6). */
  mode: "create" | "edit";
  /** Field errors by config key; "_config" for the whole config. */
  errors?: Record<string, string>;
  /** The identity fields of the type (IDENTITY_FIELDS of configs.ts, passed by the server page). */
  identityFields?: readonly string[];
  /** Fields not to show (the wizard hides the identity fields when one form sets the options of several entries). */
  hiddenFields?: readonly string[];
  disabled?: boolean;
}

const IDENTITY_HINT = "This field identifies the source. To follow another one, add a new source.";

export function SourceConfigForm({
  type,
  value,
  onChange,
  mode,
  errors = {},
  identityFields = [],
  hiddenFields = [],
  disabled = false,
}: SourceConfigFormProps) {
  const baseId = useId();
  const config: ConfigObject = value && typeof value === "object" ? (value as ConfigObject) : {};
  const fields = configFields(type, config).filter((field) => !hiddenFields.includes(field.key));
  const variant = variantLabel(type, variantOf(config));

  if (fields.length === 0 && !variant) {
    return <p className="text-sm text-muted">This type has no more options.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {errors._config ? <Banner tone="alert">{errors._config}</Banner> : null}
      {variant ? (
        <p className="text-sm text-muted">
          Kind: <span className="font-medium text-fg">{variant}</span>
        </p>
      ) : null}
      {fields.length === 0 ? <p className="text-sm text-muted">This kind of source has no more options.</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <ConfigFieldControl
            key={`${variantOf(config) ?? ""}:${field.key}`}
            id={`${baseId}-${field.key}`}
            field={field}
            value={config[field.key]}
            error={errors[field.key] ?? null}
            readOnly={mode === "edit" && identityFields.includes(field.key)}
            disabled={disabled}
            onValue={(next) => onChange(setConfigValue(config, field.key, next))}
          />
        ))}
      </div>
    </div>
  );
}

function ConfigFieldControl({
  id,
  field,
  value,
  error,
  readOnly,
  disabled,
  onValue,
}: {
  id: string;
  field: ConfigField;
  value: unknown;
  error: string | null;
  readOnly: boolean;
  disabled: boolean;
  onValue: (next: unknown) => void;
}) {
  const hint = readOnly ? `${field.help} ${IDENTITY_HINT}` : field.help;
  const describedBy = fieldDescribedBy(id, { hint, error });
  const wide = field.kind === "boolean" ? "" : field.kind === "list" || (field.kind === "text" && field.maxLength > 200) ? "sm:col-span-2" : "";

  if (field.kind === "boolean") {
    return (
      <div className="sm:col-span-2">
        <Switch
          id={id}
          label={field.label}
          description={field.help}
          checked={value === true}
          disabled={disabled || readOnly}
          onChange={(e) => onValue(e.target.checked)}
        />
        {error ? (
          <p id={`${id}-error`} className="text-sm text-alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (readOnly) {
    const shown =
      field.kind === "list"
        ? listToText(value)
        : field.kind === "select"
          ? (field.options.find((o) => o.value === value)?.label ?? String(value ?? ""))
          : value === null || value === undefined
            ? ""
            : String(value);
    return (
      <Field id={id} label={field.label} hint={hint} error={error} className={wide}>
        <Input id={id} value={shown} readOnly aria-readonly="true" aria-describedby={describedBy} className="bg-surface-2 text-muted" />
      </Field>
    );
  }

  if (field.kind === "select") {
    return (
      <Field id={id} label={field.label} hint={hint} error={error} className={wide}>
        <Select
          id={id}
          value={typeof value === "string" ? value : (field.options[0]?.value ?? "")}
          options={field.options}
          disabled={disabled}
          invalid={!!error}
          aria-describedby={describedBy}
          onChange={(e) => onValue(e.target.value)}
        />
      </Field>
    );
  }

  if (field.kind === "list") {
    return (
      <Field id={id} label={field.label} hint={`${hint} Separate entries with commas.`} error={error} optional className={wide}>
        <ListInput
          id={id}
          value={value}
          placeholder={field.placeholder}
          disabled={disabled}
          invalid={!!error}
          describedBy={fieldDescribedBy(id, { hint: true, error })}
          onList={onValue}
        />
      </Field>
    );
  }

  if (field.kind === "number") {
    return (
      <Field id={id} label={field.label} hint={hint} error={error} optional={field.optional} className={wide}>
        <Input
          id={id}
          inputMode="numeric"
          value={value === undefined || value === null ? "" : String(value)}
          disabled={disabled}
          invalid={!!error}
          aria-describedby={describedBy}
          onChange={(e) => onValue(numberFieldValue(field, e.target.value))}
        />
      </Field>
    );
  }

  return (
    <Field id={id} label={field.label} hint={hint} error={error} optional={field.empty !== "required"} className={wide}>
      <Input
        id={id}
        type={field.inputMode === "url" ? "url" : field.inputMode === "email" ? "email" : "text"}
        value={typeof value === "string" ? value : ""}
        placeholder={field.placeholder}
        maxLength={field.maxLength}
        required={field.empty === "required"}
        disabled={disabled}
        invalid={!!error}
        aria-describedby={describedBy}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => onValue(textFieldValue(field, e.target.value))}
      />
    </Field>
  );
}

/** A list as comma-separated text. It keeps the typed text, so that "a, " stays while the person types. */
function ListInput({
  id,
  value,
  placeholder,
  disabled,
  invalid,
  describedBy,
  onList,
}: {
  id: string;
  value: unknown;
  placeholder?: string;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  onList: (list: string[]) => void;
}) {
  const external = listToText(value);
  const [draft, setDraft] = useState(external);
  const [seen, setSeen] = useState(external);
  // A new value from outside (for example a reset) replaces the draft.
  if (external !== seen) {
    setSeen(external);
    if (listToText(textToList(draft)) !== external) setDraft(external);
  }
  return (
    <Input
      id={id}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      invalid={invalid}
      aria-describedby={describedBy}
      spellCheck={false}
      autoCapitalize="off"
      onChange={(e) => {
        setDraft(e.target.value);
        const list = textToList(e.target.value);
        setSeen(listToText(list));
        onList(list);
      }}
    />
  );
}
