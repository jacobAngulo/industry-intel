"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";

import { Button, EmptyState, LinkButton, PageContainer } from "@/components/ui";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // A server error reaches the browser with a generic message and a digest only (no details).
  const digest =
    error && typeof error === "object" && "digest" in error && typeof error.digest === "string" ? error.digest : null;

  return (
    <PageContainer>
      <EmptyState
        as="h1"
        icon="error"
        title="This page did not load"
        description={
          <>
            <p>Something went wrong on the server. Try again. If the problem stays, open the Status page.</p>
            {digest ? <p className="mt-2 font-mono text-xs">Reference: {digest}</p> : null}
          </>
        }
        actions={
          <>
            <Button variant="primary" icon="refresh" onClick={() => retry()}>
              Try again
            </Button>
            <LinkButton href="/status" variant="secondary">
              Open Status
            </LinkButton>
          </>
        }
      />
    </PageContainer>
  );
}
