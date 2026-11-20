"use client";

import { useRef, useState } from "react";

import { Button, Field, Input, fieldDescribedBy } from "@/components/ui";

import { addPhrase, removePhrase } from "./helpers";

export interface PhraseListEditorProps {
  /** The id prefix of the controls. */
  id: string;
  /** The label of the add field, for example "Add an exclusion". */
  addLabel: string;
  /** The accessible name of the list, for example "Exclusions". */
  listLabel: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** An error from the server for the list. */
  error?: string | null;
  placeholder?: string;
  emptyText?: string;
}

/** A list of short phrases with "Remove" for each and an "Add" field. Changes stay local until the section saves. */
export function PhraseListEditor({
  id,
  addLabel,
  listLabel,
  value,
  onChange,
  error,
  placeholder,
  emptyText = "No phrase yet.",
}: PhraseListEditorProps) {
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `${id}-add`;
  const shownError = addError ?? error ?? null;

  const add = () => {
    const result = addPhrase(value, draft);
    if ("error" in result) {
      setAddError(result.error);
      return;
    }
    setAddError(null);
    setDraft("");
    onChange(result.list);
  };

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <p className="text-sm text-muted">{emptyText}</p>
      ) : (
        <ul aria-label={listLabel} className="flex flex-wrap gap-2">
          {value.map((phrase, index) => (
            <li
              key={`${phrase}-${index}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-0.5 pl-3 text-sm"
            >
              <span className="min-w-0 break-words">{phrase}</span>
              <button
                type="button"
                onClick={() => {
                  onChange(removePhrase(value, index));
                  inputRef.current?.focus();
                }}
                className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg sm:min-h-7 sm:min-w-7"
              >
                <span aria-hidden="true">×</span>
                <span className="sr-only">Remove {phrase}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Field id={inputId} label={addLabel} error={shownError} className="max-w-xl">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            id={inputId}
            value={draft}
            maxLength={300}
            placeholder={placeholder}
            invalid={!!shownError}
            aria-describedby={fieldDescribedBy(inputId, { error: shownError })}
            className="min-w-0 flex-1"
            onChange={(e) => {
              setDraft(e.target.value);
              if (addError) setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button icon="add" onClick={add}>
            Add
          </Button>
        </div>
      </Field>
    </div>
  );
}
