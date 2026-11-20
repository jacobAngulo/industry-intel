"use client";

import { useSyncExternalStore } from "react";

import { cn } from "./cn";
import { formatAbsolute, formatAbsoluteUtc, formatDateUtc, formatRelative } from "./time-format";

// One shared clock for every RelativeTime on the page. The value changes each
// 30 s, and when the tab becomes visible again.
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
// The clock value of the browser. Read once when the module loads, then at
// each tick (render code never calls Date.now()).
let clock = typeof window === "undefined" ? 0 : Date.now();

function notify() {
  clock = Date.now();
  for (const l of listeners) l();
}

function onVisibility() {
  if (document.visibilityState === "visible") notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (Date.now() - clock > 5_000) queueMicrotask(notify);
  if (listeners.size === 1) {
    timer = setInterval(notify, TICK_MS);
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

// The snapshot is the clock value (stable between ticks).
function getSnapshot(): number {
  return clock;
}

export interface RelativeTimeProps {
  /** The instant (epoch ms). */
  at: number;
  /**
   * The time of the server render (epoch ms), for example `nowMs()` in the page.
   * With it, the server HTML already says "3 h ago". Without it, the server HTML
   * shows the UTC date, and the browser shows the relative text after hydration.
   * The two cases give no hydration mismatch.
   */
  now?: number;
  /** Text before the time, for example "Last check:". */
  prefix?: string;
  className?: string;
}

/**
 * "3 h ago" with the absolute time in the title (tooltip) and in a <time datetime>.
 * The text updates each 30 s.
 */
export function RelativeTime({ at, now, prefix, className }: RelativeTimeProps) {
  // The server snapshot is -1: during the server render and the hydration the
  // component uses `now` (or the UTC date). After that it reads the clock at each tick.
  const clientNow = useSyncExternalStore(subscribe, getSnapshot, () => -1);
  const hydrated = clientNow >= 0;

  let text: string;
  let title: string;
  if (hydrated) {
    text = formatRelative(at, clientNow);
    title = formatAbsolute(at);
  } else if (now !== undefined) {
    text = formatRelative(at, now);
    title = formatAbsoluteUtc(at);
  } else {
    text = formatDateUtc(at);
    title = formatAbsoluteUtc(at);
  }

  return (
    <time dateTime={new Date(at).toISOString()} title={title} className={cn("whitespace-nowrap", className)}>
      {prefix ? `${prefix} ` : null}
      {text}
    </time>
  );
}
