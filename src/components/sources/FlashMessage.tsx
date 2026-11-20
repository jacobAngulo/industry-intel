"use client";

// A short message that survives one navigation (for example "Added 3
// sources" after the add-source flow). It lives in sessionStorage of this tab
// and shows once. Without storage, nothing shows: the page still works.
import { useEffect, useState } from "react";

import { Banner, Button } from "@/components/ui";

const KEY = "ii.sourceFlash";
const EVENT = "ii:source-flash";

export interface Flash {
  tone: "info" | "warning";
  title: string;
  lines?: string[];
}

/**
 * Stores the message for the next page of this tab. With `samePage` the
 * FlashMessage of the current page shows it at once (no navigation follows).
 */
export function setFlash(flash: Flash, opts: { samePage?: boolean } = {}): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(flash));
  } catch {
    // No storage (private window, blocked): the message is lost, nothing else.
  }
  if (opts.samePage) window.dispatchEvent(new Event(EVENT));
}

function takeFlash(): Flash | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw) as Partial<Flash>;
    if (typeof value.title !== "string") return null;
    return {
      tone: value.tone === "warning" ? "warning" : "info",
      title: value.title,
      lines: Array.isArray(value.lines) ? value.lines.filter((l): l is string => typeof l === "string") : [],
    };
  } catch {
    return null;
  }
}

/** Shows the stored message once, in a live region. */
export function FlashMessage() {
  const [flash, setFlashState] = useState<Flash | null>(null);

  useEffect(() => {
    const show = () => {
      const value = takeFlash();
      if (value) setFlashState(value);
    };
    // Reading sessionStorage must wait for the browser (no hydration mismatch).
    show();
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);

  return (
    <div role="status" aria-live="polite" className={flash ? "mb-6" : undefined}>
      {flash ? (
        <Banner
          tone={flash.tone}
          title={flash.title}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setFlashState(null)}>
              Close
            </Button>
          }
        >
          {flash.lines && flash.lines.length > 0 ? (
            <ul className="list-disc pl-5">
              {flash.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
    </div>
  );
}
