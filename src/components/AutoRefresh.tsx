"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export interface AutoRefreshProps {
  /** The interval in milliseconds (at least 1000). */
  everyMs: number;
  /** Refresh only while this is true. */
  active: boolean;
}

/**
 * Calls `router.refresh()` each `everyMs` while `active` is true and the tab
 * is visible (specification §15). It is the only polling method of the app.
 * When a hidden tab becomes visible again, it refreshes at once. It renders nothing.
 */
export function AutoRefresh({ everyMs, active }: AutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const interval = Math.max(1000, everyMs);
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), interval);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, everyMs, router]);

  return null;
}
