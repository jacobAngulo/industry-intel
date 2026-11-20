"use client";

import { useSyncExternalStore } from "react";

import { DISMISSED_ALERTS_EVENT, DISMISSED_ALERTS_KEY, readDismissedAlerts } from "./dismissed-alerts";

let cachedRaw: string | null | undefined;
let cachedIds: number[] = [];

function snapshot(): number[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DISMISSED_ALERTS_KEY);
  } catch {
    raw = null;
  }
  // The same array while the stored text stays the same (useSyncExternalStore needs a stable value).
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedIds = readDismissedAlerts();
  }
  return cachedIds;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === DISMISSED_ALERTS_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(DISMISSED_ALERTS_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(DISMISSED_ALERTS_EVENT, listener);
  };
}

/**
 * The dismissed alert ids of this browser, live. `null` during the server
 * render and the hydration (unknown): show no dot and no banner until then.
 */
export function useDismissedAlerts(): number[] | null {
  return useSyncExternalStore<number[] | null>(subscribe, snapshot, () => null);
}
