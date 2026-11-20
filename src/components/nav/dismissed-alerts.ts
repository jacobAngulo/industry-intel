// The alerts that this browser dismissed (specification §9.3): a list of alert
// ids in localStorage under the key "ii.dismissedAlerts". The feed tab dot and
// the alert banner of the feed page use these helpers. No React here.

export const DISMISSED_ALERTS_KEY = "ii.dismissedAlerts";
/** The event that this tab sends after a change (the "storage" event covers the other tabs). */
export const DISMISSED_ALERTS_EVENT = "ii:dismissed-alerts";
/** The list keeps the newest ids only. */
export const DISMISSED_ALERTS_MAX = 500;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // Storage can be blocked (privacy settings).
  }
}

/** Parses the stored text. Bad or missing data gives []. */
export function parseDismissedAlerts(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0);
  } catch {
    return [];
  }
}

/** The dismissed alert ids of this browser. */
export function readDismissedAlerts(storage: StorageLike | null = defaultStorage()): number[] {
  if (!storage) return [];
  try {
    return parseDismissedAlerts(storage.getItem(DISMISSED_ALERTS_KEY));
  } catch {
    return [];
  }
}

/** Adds alert ids to the dismissed list (no duplicates, newest kept) and tells the open components. */
export function dismissAlerts(ids: readonly number[], storage: StorageLike | null = defaultStorage()): number[] {
  const current = readDismissedAlerts(storage);
  const set = new Set(current);
  const merged = [...current, ...ids.filter((id) => Number.isInteger(id) && id > 0 && !set.has(id))];
  const unique = [...new Set(merged)].slice(-DISMISSED_ALERTS_MAX);
  if (storage) {
    try {
      storage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(unique));
    } catch {
      // Full or blocked storage: the alert shows again on the next page load.
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DISMISSED_ALERTS_EVENT));
  }
  return unique;
}

/** True when at least one of `alertIds` is not in `dismissed`. */
export function hasUndismissedAlerts(alertIds: readonly number[], dismissed: readonly number[]): boolean {
  if (alertIds.length === 0) return false;
  const set = new Set(dismissed);
  return alertIds.some((id) => !set.has(id));
}

/** The ids of `alertIds` that are not dismissed. */
export function undismissedAlerts(alertIds: readonly number[], dismissed: readonly number[]): number[] {
  const set = new Set(dismissed);
  return alertIds.filter((id) => !set.has(id));
}
