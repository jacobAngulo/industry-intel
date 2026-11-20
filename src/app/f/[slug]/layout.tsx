import { notFound } from "next/navigation";

import { FeedFrame } from "@/components/feed/FeedFrame";
import { loadActiveFeed } from "@/components/feed/load-feed";

/**
 * Every page inside a feed (§3): the compact feed header with the tabs
 * Stories · Digests · Settings, then the page, in one column (860 px; 1120 px
 * for the settings pages). The pages below do not add their own container.
 * A feed that does not exist or is archived answers 404.
 */
export default async function FeedLayout({ children, params }: LayoutProps<"/f/[slug]">) {
  const { slug } = await params;
  const feed = await loadActiveFeed(slug);
  if (!feed) notFound();
  return (
    <FeedFrame slug={feed.slug} name={feed.name} purpose={feed.purpose}>
      {children}
    </FeedFrame>
  );
}
