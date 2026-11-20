"use client";

import { useCallback, useTransition } from "react";

import { useNameGate } from "@/components/NameGate";
import type { ActionResult } from "@/lib/services/types";

export const ACTION_FAILED_MESSAGE = "The request did not reach the server. Check the connection and try again.";

/**
 * Runs a Server Action from an event handler: first the name gate (§15: every
 * change except a vote needs a display name), then the action in a
 * transition. `onResult` gets the result; a network failure becomes a failure result.
 * Render `dialog` in the component.
 */
export function useGatedAction(name: string | null) {
  const { ensureName, dialog, name: effectiveName, currentName } = useNameGate(name);
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    <T>(
      /** Gets the display name at call time (also a name that the gate saved just before). */
      action: (name: string | null) => Promise<ActionResult<T>>,
      onResult: (result: ActionResult<T>) => void,
      opts: { needsName?: boolean } = {},
    ) => {
      void (async () => {
        if (opts.needsName !== false && !(await ensureName())) return;
        startTransition(async () => {
          let result: ActionResult<T>;
          try {
            result = await action(currentName());
          } catch {
            result = { ok: false, message: ACTION_FAILED_MESSAGE };
          }
          onResult(result);
        });
      })();
    },
    [ensureName, currentName],
  );

  return { run, pending, dialog, name: effectiveName };
}
