import type { Metadata } from "next";

import { EmptyState, LinkButton, PageContainer } from "@/components/ui";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <PageContainer>
      <EmptyState
        as="h1"
        icon="search"
        title="Page not found"
        description={
          <p>
            This page does not exist, or the feed, story, or source was removed. Use the feed tabs above, or go to the
            start page.
          </p>
        }
        actions={
          <>
            <LinkButton href="/" variant="primary">
              Go to the start page
            </LinkButton>
            <LinkButton href="/sources" variant="secondary">
              Open the source directory
            </LinkButton>
          </>
        }
      />
    </PageContainer>
  );
}
