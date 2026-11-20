"use client";

import { useState } from "react";

import { removeKeyAction, saveKeyAction } from "@/app/settings/actions";
import { useNameGate } from "@/components/NameGate";
import { Badge, Button, Field, Input, fieldDescribedBy, formatAbsoluteUtc } from "@/components/ui";

import { SaveRow } from "./SettingsSection";
import { useSave } from "./use-save";

/** What the page knows about one key: never the value. */
export interface KeyRowData {
  name: "OLLAMA_API_KEY" | "X_BEARER_TOKEN";
  label: string;
  hint: string;
  source: "saved" | "env" | "missing";
  inEnvFile: boolean;
  savedAt: number | null;
  savedBy: string | null;
}

/** §4.9 API keys: write-only fields. A saved key wins over .env; Remove falls back to .env. */
export function KeysForm({ keys, name }: { keys: KeyRowData[]; name: string | null }) {
  const { ensureName, dialog } = useNameGate(name);
  return (
    <div className="flex max-w-xl flex-col gap-6">
      {keys.map((k) => (
        <KeyRow key={k.name} data={k} ensureName={ensureName} />
      ))}
      {dialog}
    </div>
  );
}

function sourceBadge(data: KeyRowData) {
  if (data.source === "saved") return <Badge tone="success">Saved here</Badge>;
  if (data.source === "env") return <Badge tone="neutral">From .env</Badge>;
  return <Badge tone="warning">Missing</Badge>;
}

function KeyRow({ data, ensureName }: { data: KeyRowData; ensureName: () => Promise<boolean> }) {
  const save = useSave(saveKeyAction, ensureName);
  const remove = useSave(removeKeyAction, ensureName);
  const [value, setValue] = useState("");
  const id = `key-${data.name.toLowerCase()}`;
  const error = save.failure?.fieldErrors.value ?? null;

  const savedLine =
    data.source === "saved" && data.savedAt !== null
      ? `Saved ${formatAbsoluteUtc(data.savedAt)}${data.savedBy ? ` by ${data.savedBy}` : ""}.${
          data.inEnvFile ? " It replaces the value in .env." : ""
        }`
      : null;

  return (
    <form
      id={save.formId}
      noValidate
      autoComplete="off"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run({ name: data.name, value }, () => setValue(""));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{data.label}</span>
        {sourceBadge(data)}
        <code className="text-xs text-muted">{data.name}</code>
      </div>
      {savedLine ? <p className="text-sm text-muted">{savedLine}</p> : null}
      <Field
        id={id}
        label={data.source === "missing" ? `New ${data.label}` : `Replace the ${data.label}`}
        labelHidden
        hint={data.hint}
        error={error}
      >
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={data.source === "missing" ? "Paste the key" : "Paste a new key to replace it"}
          value={value}
          invalid={!!error}
          aria-describedby={fieldDescribedBy(id, { hint: true, error })}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-start gap-3">
        <SaveRow
          pending={save.pending}
          savedAt={save.savedAt}
          error={error ? null : save.failure?.message}
          label="Save key"
          disabled={value.trim() === ""}
        />
        {data.source === "saved" ? (
          <Button
            variant="ghost"
            icon="delete"
            pending={remove.pending}
            pendingLabel="Removing"
            onClick={() => void remove.run({ name: data.name })}
          >
            Remove saved key<span className="sr-only">: {data.label}</span>
          </Button>
        ) : null}
      </div>
      {remove.failure ? (
        <p role="alert" className="text-sm text-alert">
          {remove.failure.message}
        </p>
      ) : null}
    </form>
  );
}
