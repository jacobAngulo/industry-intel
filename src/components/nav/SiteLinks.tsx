"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { signOutAction } from "@/app/_lib/auth-actions";
import { Icon, cn, pathMatches } from "@/components/ui";

const LINKS = [
  { href: "/sources", label: "Sources" },
  { href: "/settings", label: "Settings" },
  { href: "/status", label: "Status" },
] as const;

export interface SiteLinksProps {
  /** The name of the signed-in person. */
  name: string;
  className?: string;
}

/** The name of the signed-in person, and the sign-out button. */
export function UserMenu({ name, wide = false }: { name: string; wide?: boolean }) {
  return (
    <form action={signOutAction} className={cn("flex items-center gap-1 text-sm", wide && "justify-between px-3")}>
      <span className="inline-flex min-w-0 max-w-[10rem] items-center gap-1.5 px-1 text-fg">
        <Icon name="user" size={15} className="shrink-0 text-muted" />
        <span className="sr-only">Signed in as </span>
        <span className="truncate">{name}</span>
      </span>
      <button type="submit" className="min-h-10 rounded-control px-2 text-muted hover:bg-surface-2 hover:text-fg">
        Sign out
      </button>
    </form>
  );
}

/**
 * The right side of the top navigation: Sources, Settings, Status, and the
 * signed-in person. At phone width the links fold into a "Menu" (native <details>).
 */
export function SiteLinks({ name, className }: SiteLinksProps) {
  const pathname = usePathname() ?? "";
  const menu = useRef<HTMLDetailsElement>(null);

  // Close the phone menu after a navigation.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);

  const link = (href: string, label: string, vertical: boolean) => {
    const current = pathMatches(pathname, href);
    return (
      <Link
        key={href}
        href={href}
        aria-current={current ? "page" : undefined}
        className={cn(
          "inline-flex min-h-10 items-center rounded-control px-2.5 text-sm no-underline transition-colors",
          vertical && "w-full px-3",
          current ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
        )}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className={cn("flex items-center", className)}>
      {/* Wide screens: one row. */}
      <nav aria-label="Site" className="hidden items-center gap-1 lg:flex">
        {LINKS.map((l) => link(l.href, l.label, false))}
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <UserMenu name={name} />
      </nav>

      {/* Phone and tablet: a menu. */}
      <details
        ref={menu}
        className="relative lg:hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape" && menu.current?.open) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary className="ui-summary inline-flex min-h-10 items-center gap-1.5 rounded-control border border-border px-3 text-sm text-fg hover:bg-surface-2">
          <Icon name="menu" size={16} />
          Menu
        </summary>
        <div className="absolute top-full right-0 z-40 mt-2 flex w-56 flex-col gap-1 rounded-card border border-border bg-surface p-2 shadow-lg">
          <nav aria-label="Site" className="flex flex-col gap-1">
            {LINKS.map((l) => link(l.href, l.label, true))}
          </nav>
          <div className="mt-1 border-t border-border pt-2">
            <UserMenu name={name} wide />
          </div>
        </div>
      </details>
    </div>
  );
}
