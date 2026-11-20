// Server only: the feed of a route, read once for each request (the layout
// and the page both need it).
import { cache } from "react";

import { getFeedBySlug, type FeedDetail } from "@/lib/services";

/** The active feed with this slug, or null when it does not exist or is archived. */
export const loadActiveFeed = cache(async (slug: string): Promise<FeedDetail | null> => {
  let decoded = slug;
  if (slug.includes("%")) {
    try {
      decoded = decodeURIComponent(slug);
    } catch {
      return null;
    }
  }
  const feed = await getFeedBySlug(decoded);
  return feed && !feed.archived ? feed : null;
});
