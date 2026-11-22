import type { Metadata } from "next";

import { requireUser } from "@/app/_lib/identity";
import { PageContainer, PageHeader } from "@/components/ui";

import { NewFeedForm } from "./NewFeedForm";

export const metadata: Metadata = { title: "New feed" };

/** Create a feed (§3): name and purpose. New feeds start from the shared defaults; then the person picks the sources. */
export default async function NewFeedPage() {
  await requireUser();
  return (
    <PageContainer>
      <PageHeader
        title="New feed"
        description="A feed is a shared view with its own purpose, sources, and interests. It starts from the shared defaults. Next, you choose its sources."
      />
      <NewFeedForm />
    </PageContainer>
  );
}
