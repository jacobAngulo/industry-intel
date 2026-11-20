"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";

import { setName } from "@/app/_lib/actions";
import { NAME_MAX_LENGTH } from "@/app/_lib/identity-constants";
import { Button, Dialog, Field, Input, fieldDescribedBy } from "@/components/ui";

export const NAME_DIALOG_TEXT = "There is no login. Your name shows next to the things that you add or change.";

export interface NameDialogProps {
  open: boolean;
  /** The current name (prefills the field when the person changes it). */
  currentName?: string | null;
  /** Called with the saved name. */
  onSaved: (name: string) => void;
  /** Called when the dialog closes without a save. */
  onCancel: () => void;
  /** The text of the save button (default "Save name"; the gate uses "Save and continue"). */
  saveLabel?: string;
}

/** The dialog that asks for the display name and stores it with the Server Action setName. */
export function NameDialog({ open, currentName, onSaved, onCancel, saveLabel = "Save name" }: NameDialogProps) {
  const id = useId();
  const inputId = `${id}-name`;
  const [value, setValue] = useState(currentName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const savedRef = useRef(false);

  useEffect(() => {
    if (open) {
      savedRef.current = false;
    }
  }, [open]);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setName(value);
        if (result.ok) {
          savedRef.current = true;
          onSaved(result.data.name);
        } else {
          setError(result.fieldErrors?.name ?? result.message);
        }
      } catch {
        setError("The name was not saved. Check the connection and try again.");
      }
    });
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!savedRef.current) onCancel();
      }}
      title={currentName ? "Change your name" : "Set your name"}
      description={NAME_DIALOG_TEXT}
      size="sm"
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          submit();
        }}
        className="flex flex-col gap-4"
      >
        <Field id={inputId} label="Your name" error={error} hint={`1 to ${NAME_MAX_LENGTH} characters.`}>
          <Input
            id={inputId}
            name="name"
            autoComplete="name"
            autoFocus
            required
            maxLength={NAME_MAX_LENGTH}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            invalid={!!error}
            aria-describedby={fieldDescribedBy(inputId, { hint: true, error })}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving">
            {saveLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * For code that calls a Server Action directly (not through a form): `await ensureName()`
 * opens the dialog when no name is set and resolves true after a save, false after a cancel.
 * Render `dialog` somewhere in the component.
 */
export function useNameGate(name: string | null): {
  name: string | null;
  ensureName: () => Promise<boolean>;
  /** The display name now, also one that the dialog saved after the last render (for code that runs after `ensureName`). */
  currentName: () => string | null;
  dialog: ReactNode;
} {
  const router = useRouter();
  const [saved, setSaved] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const nameRef = useRef<string | null>(name);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const effective = saved ?? name;

  useEffect(() => {
    nameRef.current = effective;
  }, [effective]);

  const ensureName = useCallback((): Promise<boolean> => {
    if (nameRef.current) return Promise.resolve(true);
    resolver.current?.(false);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const currentName = useCallback((): string | null => nameRef.current, []);

  const dialog = (
    <NameDialog
      open={open}
      saveLabel="Save and continue"
      onSaved={(n) => {
        nameRef.current = n;
        setSaved(n);
        setOpen(false);
        resolver.current?.(true);
        resolver.current = null;
        router.refresh();
      }}
      onCancel={() => {
        setOpen(false);
        resolver.current?.(false);
        resolver.current = null;
      }}
    />
  );
  return { name: effective, ensureName, currentName, dialog };
}

type PendingAction =
  | { kind: "submit"; form: HTMLFormElement; submitter: HTMLElement | null }
  | { kind: "click"; element: HTMLElement };

export interface NameGateProps {
  /** The current display name from the server (`(await getActor()).name`), or null. */
  name: string | null;
  /** A form, or a button (or any element with the attribute `data-needs-name`). */
  children: ReactNode;
}

/**
 * Wraps a form or a button whose action needs a display name (every change
 * except a vote, §15). When no name is set, a submit or a click opens the name
 * dialog first; after the save the wrapped action continues (the form submits
 * again with the same submit button, or the button is clicked again).
 */
export function NameGate({ name, children }: NameGateProps) {
  const { ensureName, dialog } = useNameGate(name);
  const nameRef = useRef<string | null>(name);
  const pending = useRef<PendingAction | null>(null);
  const bypass = useRef(false);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  const gate = (action: PendingAction) => {
    pending.current = action;
    void ensureName().then((saved) => {
      const next = pending.current;
      pending.current = null;
      if (!saved || !next) return;
      nameRef.current = "set";
      bypass.current = true;
      try {
        if (next.kind === "submit") {
          if (next.submitter && next.submitter.isConnected) next.form.requestSubmit(next.submitter as HTMLButtonElement);
          else next.form.requestSubmit();
        } else if (next.element.isConnected) {
          next.element.click();
        }
      } finally {
        bypass.current = false;
      }
    });
  };

  // The dialog is a sibling of the wrapper, so that its own form and buttons are not gated.
  return (
    <>
    <div
      className="contents"
      onSubmitCapture={(e) => {
        if (nameRef.current || bypass.current) return;
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        e.preventDefault();
        e.stopPropagation();
        const native = e.nativeEvent as SubmitEvent;
        gate({ kind: "submit", form, submitter: native.submitter instanceof HTMLElement ? native.submitter : null });
      }}
      onClickCapture={(e) => {
        if (nameRef.current || bypass.current) return;
        const target = e.target instanceof Element ? e.target : null;
        const element = target?.closest<HTMLElement>("button, [data-needs-name]");
        if (!element || !e.currentTarget.contains(element)) return;
        // A submit button of a form: the submit handler above gates it.
        if (element instanceof HTMLButtonElement && element.type === "submit" && element.form) return;
        if (element instanceof HTMLButtonElement && element.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        gate({ kind: "click", element });
      }}
    >
      {children}
    </div>
    {dialog}
    </>
  );
}
