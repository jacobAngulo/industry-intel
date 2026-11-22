"use client";

import { useState, useTransition } from "react";

import { addSuggestionAction } from "@/app/f/[slug]/actions";
import { Button, SourceTypeIcon } from "@/components/ui";
import { SOURCE_TYPE_LABELS, type SourceType } from "@/lib/types";

export interface SuggestionRow {
  name: string;
  type: SourceType;
  why: string;
}

/**
 * The starter suggestions of §12 for this feed, each with "Add" (the empty
 * state "no sources").
 */
export function SuggestionList({
  feedSlug,
  suggestions,
}: {
  feedSlug: string;
  suggestions: SuggestionRow[];
}) {
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [, startTransition] = useTransition();

  const add = async (suggestion: SuggestionRow) => {
    if (pendingName) return;
    setMessage(null);
    setPendingName(suggestion.name);
    startTransition(async () => {
      try {
        const result = await addSuggestionAction({ feedSlug, name: suggestion.name });
        if (result.ok) {
          setAdded((list) => [...list, suggestion.name]);
          setMessage({
            tone: "ok",
            text: `Added ${result.data.name}. The first check runs now; stories show here in a few minutes.`,
          });
        } else {
          setMessage({ tone: "error", text: result.message });
        }
      } catch {
        setMessage({ tone: "error", text: "The source was not added. Check the connection and try again." });
      } finally {
        setPendingName(null);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
        {suggestions.map((s) => {
          const isAdded = added.includes(s.name);
          return (
            <li key={s.name} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium text-fg">
                  <SourceTypeIcon type={s.type} className="text-muted" />
                  <span>{s.name}</span>
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {SOURCE_TYPE_LABELS[s.type]} · {s.why}
                </p>
              </div>
              {isAdded ? (
                <span className="inline-flex items-center gap-1 text-sm text-success">Added</span>
              ) : (
                <Button
                  size="sm"
                  icon="add"
                  pending={pendingName === s.name}
                  pendingLabel="Adding"
                  onClick={() => void add(s)}
                  className="self-start sm:self-auto"
                >
                  Add<span className="sr-only">: {s.name}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p
        role={message?.tone === "error" ? "alert" : "status"}
        aria-live="polite"
        className={message ? (message.tone === "error" ? "text-sm text-alert" : "text-sm text-success") : "sr-only"}
      >
        {message?.text}
      </p>
    </div>
  );
}
