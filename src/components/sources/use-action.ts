"use client";

import { useCallback, useTransition } from "react";

import type { ActionResult } from "@/lib/services/types";

export const ACTION_FAILED_MESSAGE = "The request did not reach the server. Check the connection and try again.";

/** Runs a Server Action from an event handler in a transition. A network failure becomes a failure result. */
export function useAction() {
  const [pending, startTransition] = useTransition();

  const run = useCallback(<T>(action: () => Promise<ActionResult<T>>, onResult: (result: ActionResult<T>) => void) => {
    startTransition(async () => {
      let result: ActionResult<T>;
      try {
        result = await action();
      } catch {
        result = { ok: false, message: ACTION_FAILED_MESSAGE };
      }
      onResult(result);
    });
  }, []);

  return { run, pending };
}
