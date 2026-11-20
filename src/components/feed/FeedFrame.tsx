"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { NavTabs, cn } from "@/components/ui";

/**
 * The frame of every page inside a feed: the compact feed header (the feed
 * name, the purpose in one line, the tabs Stories · Digests · Settings) and
 * the page below it, in one column. The column is 1120 px wide for the
 * settings pages and 860 px for the others (§15). The feed name is not a
 * heading: each page has its own h1.
 */
export function FeedFrame({
  slug,
  name,
  purpose,
  children,
}: {
  slug: string;
  name: string;
  purpose: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const base = `/f/${encodeURIComponent(slug)}`;
  const wide = pathname.startsWith(`${base}/settings`) || pathname.startsWith(`/f/${slug}/settings`);
  return (
    <div className={cn("mx-auto w-full px-4 pt-4 pb-10 sm:px-6 sm:pt-6", wide ? "max-w-[1120px]" : "max-w-[860px]")}>
      <div className="border-b border-border">
        <p className="font-serif text-xl leading-tight font-semibold tracking-tight text-fg sm:text-2xl">{name}</p>
        {purpose ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted sm:line-clamp-1" title={purpose}>
            {purpose}
          </p>
        ) : null}
        <NavTabs
          label="Feed sections"
          className="mt-2"
          items={[
            { href: base, label: "Stories", match: "exact", alsoMatch: [`${base}/story`] },
            { href: `${base}/digests`, label: "Digests" },
            { href: `${base}/settings`, label: "Settings" },
          ]}
        />
      </div>
      <div className="pt-4 sm:pt-5">{children}</div>
    </div>
  );
}
