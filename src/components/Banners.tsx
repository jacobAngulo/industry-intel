import type { AppBanner } from "@/lib/services/types";

import { Banner, cn } from "@/components/ui";

export interface BannersProps {
  /** The banners from `getBanners(feedId?)` of "@/lib/services". */
  banners: AppBanner[];
  /**
   * Kinds to leave out. The root layout shows `worker_down` on every page, so a
   * feed page passes `exclude={["worker_down"]}` to show it only once.
   */
  exclude?: AppBanner["kind"][];
  /** "thin": compact one-line banners (the app-wide banner in the layout). */
  density?: "normal" | "thin";
  className?: string;
}

/** The state banners of specification §13. Renders nothing when no banner applies. */
export function Banners({ banners, exclude = [], density = "normal", className }: BannersProps) {
  const shown = banners.filter((b) => !exclude.includes(b.kind));
  if (shown.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {shown.map((b) => (
        <Banner key={b.kind} tone={b.tone === "warning" ? "warning" : "info"} link={b.link} density={density}>
          {b.message}
        </Banner>
      ))}
    </div>
  );
}
