import { notFound } from "next/navigation";

import { RejudgeProgressLine } from "@/components/settings/RejudgeProgressLine";
import { NavTabs } from "@/components/ui";
import { getFeedBySlug, rejudgeProgress } from "@/lib/services";

/** The four settings groups of a feed (§4.8), with the re-judge progress line of the feed. */
export default async function FeedSettingsLayout({ children, params }: LayoutProps<"/f/[slug]/settings">) {
  const { slug } = await params;
  const feed = await getFeedBySlug(slug);
  if (!feed || feed.archived) notFound();
  const progress = await rejudgeProgress(feed.id);
  const base = `/f/${feed.slug}/settings`;

  return (
    <div className="flex flex-col gap-6">
      <NavTabs
        label="Settings groups"
        variant="pill"
        items={[
          { href: `${base}/sources`, label: "Sources" },
          { href: `${base}/profile`, label: "Feed Profile" },
          { href: `${base}/interests`, label: "Interests" },
          { href: `${base}/delivery`, label: "Delivery" },
        ]}
      />
      <RejudgeProgressLine progress={progress} showFinished={false} />
      {children}
    </div>
  );
}
