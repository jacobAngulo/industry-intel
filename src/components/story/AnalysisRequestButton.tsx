"use client";

import { useState, useTransition } from "react";

import { requestAnalysisAction } from "@/app/f/[slug]/actions";
import { Button, type ButtonVariant } from "@/components/ui";

/**
 * "Write the deeper analysis", "Write again", or "Try again" (§4.2). Needs a
 * display name: the name dialog opens first when none is set. After the
 * request the page shows the progress line (revalidated by the action).
 */
export function AnalysisRequestButton({
  feedSlug,
  storyId,
  label,
  variant = "primary",
}: {
  feedSlug: string;
  storyId: number;
  label: string;
  variant?: ButtonVariant;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const request = async () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await requestAnalysisAction({ feedSlug, storyId });
        if (!result.ok) setError(result.message);
      } catch {
        setError("The request was not sent. Check the connection and try again.");
      }
    });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant={variant} icon="sparkles" pending={pending} pendingLabel="Sending the request" onClick={() => void request()}>
        {label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
