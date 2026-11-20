import { redirect } from "next/navigation";

import { EmptyState, LinkButton, PageContainer } from "@/components/ui";
import { listFeeds } from "@/lib/services";

// `/` (specification §3): redirect to the first active feed. With no feed, a
// page with the action "Create the first feed".
export default async function HomePage() {
  const feeds = await listFeeds();
  const first = feeds
    .filter((f) => !f.archived)
    .sort((a, b) => a.position - b.position || a.id - b.id)[0];
  if (first) redirect(`/f/${encodeURIComponent(first.slug)}`);

  return (
    <PageContainer>
      <EmptyState
        as="h1"
        icon="newspaper"
        title="No feeds yet"
        description={
          <p>
            A feed is a shared view of engineering news with its own purpose, sources, and interests. Create the first
            feed, then add the sources that it follows.
          </p>
        }
        actions={
          <>
            <LinkButton href="/feeds/new" variant="primary" icon="add">
              Create the first feed
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
