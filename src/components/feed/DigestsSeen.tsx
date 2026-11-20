"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";

import { Badge } from "@/components/ui";

import { digestsSeenKey, isDigestNew, parseDigestsSeen } from "./digest-format";

function readSeen(feedId: number): number | null {
  try {
    return parseDigestsSeen(window.localStorage.getItem(digestsSeenKey(feedId)));
  } catch {
    return null; // Storage can be blocked.
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/**
 * Stores the time of this visit to the digest list (§4.4). `at` is the time
 * of the server render, so that the "New" mark compares two server times.
 */
export function MarkDigestsSeen({ feedId, at }: { feedId: number; at: number }) {
  useEffect(() => {
    try {
      const key = digestsSeenKey(feedId);
      const before = parseDigestsSeen(window.localStorage.getItem(key));
      if (before === null || at > before) window.localStorage.setItem(key, String(at));
    } catch {
      // Blocked storage: the "New" mark shows again. Nothing else breaks.
    }
  }, [feedId, at]);
  return null;
}

/**
 * "Latest digest: <title>" with a "New" mark when the digest is newer than
 * the last visit of this browser to the digest list. The mark shows only
 * after hydration (localStorage).
 */
export function LatestDigestLink({
  feedId,
  href,
  title,
  createdAt,
}: {
  feedId: number;
  href: string;
  title: string;
  createdAt: number;
}) {
  const seen = useSyncExternalStore<number | null | undefined>(
    subscribe,
    () => readSeen(feedId),
    () => undefined,
  );
  const fresh = seen !== undefined && isDigestNew(createdAt, seen);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-muted">Latest digest:</span>
      <Link href={href} className="font-medium text-accent">
        {title}
      </Link>
      {fresh ? <Badge tone="accent">New</Badge> : null}
    </p>
  );
}
