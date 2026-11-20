"use client";

import { useCallback, useEffect, useId, useState, useTransition } from "react";

import type { ActionResult } from "@/lib/services/types";

const NETWORK_MESSAGE = "The change was not saved. Check the connection and try again.";

export interface SaveFailure {
  message: string;
  fieldErrors: Record<string, string>;
}

export interface SaveHandle<I, T> {
  /** Asks for the display name when none is set, then calls the action. `onOk` gets the result data. */
  run: (input: I, onOk?: (data: T) => void) => Promise<void>;
  pending: boolean;
  /** A counter that grows at each successful save (for <SavedNote at>). 0 = never saved. */
  savedAt: number;
  failure: SaveFailure | null;
  /** Shows a failure that the client found (no server call). */
  setFailure: (failure: SaveFailure | null) => void;
  /** The id for the form of the section: after a failure its first invalid control gets the focus. */
  formId: string;
}

/**
 * The save pattern of one settings section: name gate, pending state, the
 * "Saved" counter, the message and field errors of a failure, and the focus
 * on the first invalid control after a failure.
 */
export function useSave<I, T>(
  action: (input: I) => Promise<ActionResult<T>>,
  ensureName: () => Promise<boolean>,
): SaveHandle<I, T> {
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  // An id (not a ref) finds the form, so that the handle stays plain render data.
  const formId = useId();

  useEffect(() => {
    if (!failure || Object.keys(failure.fieldErrors).length === 0) return;
    const first = document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus();
  }, [failure, formId]);

  const run = useCallback(
    async (input: I, onOk?: (data: T) => void) => {
      setFailure(null);
      if (!(await ensureName())) return;
      startTransition(async () => {
        let result: ActionResult<T>;
        try {
          result = await action(input);
        } catch {
          result = { ok: false, message: NETWORK_MESSAGE };
        }
        if (result.ok) {
          setSavedAt((n) => n + 1);
          onOk?.(result.data);
        } else {
          setFailure({ message: result.message, fieldErrors: result.fieldErrors ?? {} });
        }
      });
    },
    [action, ensureName],
  );

  return { run, pending, savedAt, failure, setFailure, formId };
}
