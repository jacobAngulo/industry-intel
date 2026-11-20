"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "./cn";
import { pathMatches } from "./paths";

export interface NavTabItem {
  href: string;
  label: ReactNode;
  /** Force the current state. Without it the tab is current when the address matches (see `match`). */
  current?: boolean;
  /** "prefix" (default): current for the href and every address below it. "exact": only the href. */
  match?: "exact" | "prefix";
  /** More address prefixes that also mark this tab as current. */
  alsoMatch?: string[];
  /** Extra content after the label (for example a dot with screen-reader text). */
  after?: ReactNode;
}

export interface NavTabsProps {
  /** Text label of the navigation landmark, for example "Feed sections". */
  label: string;
  items: NavTabItem[];
  /** "underline" for page tabs; "pill" for compact tabs. */
  variant?: "underline" | "pill";
  /** Scroll sideways when the tabs do not fit (phone width). Default true. */
  scroll?: boolean;
  className?: string;
}

/** Tabs that are links. The current tab has aria-current="page". */
export function NavTabs({ label, items, variant = "underline", scroll = true, className }: NavTabsProps) {
  const pathname = usePathname() ?? "";
  // When several tabs match, only the longest href is current.
  let currentIndex = -1;
  let currentLength = -1;
  items.forEach((item, i) => {
    const matched =
      item.current ??
      (pathMatches(pathname, item.href, item.match) ||
        (item.alsoMatch ?? []).some((p) => pathMatches(pathname, p, "prefix")));
    if (matched && item.href.length > currentLength) {
      currentIndex = i;
      currentLength = item.href.length;
    }
  });

  return (
    <nav aria-label={label} className={cn(scroll && "scrollbar-none overflow-x-auto", className)}>
      <ul className={cn("flex items-stretch", variant === "underline" ? "gap-1 sm:gap-4" : "gap-1")}>
        {items.map((item, i) => {
          const current = i === currentIndex;
          return (
            <li key={item.href} className="flex shrink-0">
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap text-sm no-underline transition-colors",
                  variant === "underline"
                    ? cn(
                        "-mb-px border-b-2 px-2 sm:px-0.5",
                        current
                          ? "border-accent font-medium text-fg"
                          : "border-transparent text-muted hover:border-border-strong hover:text-fg",
                      )
                    : cn(
                        "rounded-control px-3",
                        current ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
                      ),
                )}
              >
                {item.label}
                {item.after}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
