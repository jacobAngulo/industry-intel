"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { NameDialog } from "@/components/NameGate";
import { Icon, cn, pathMatches } from "@/components/ui";

const LINKS = [
  { href: "/sources", label: "Sources" },
  { href: "/settings", label: "Settings" },
  { href: "/status", label: "Status" },
] as const;

export interface SiteLinksProps {
  /** The display name from the server, or null. */
  name: string | null;
  className?: string;
}

/** The button that shows the display name, or "Set your name". It opens the name dialog. */
export function NameButton({ name, wide = false }: { name: string | null; wide?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex min-h-10 items-center gap-1.5 rounded-control text-sm hover:bg-surface-2",
          wide ? "w-full justify-start px-3" : "max-w-[14rem] px-2",
          name ? "text-fg" : "font-medium text-accent",
        )}
      >
        <Icon name="user" size={15} className="text-muted" />
        {name ? (
          <>
            <span className="sr-only">Your name: </span>
            <span className="truncate">{name}</span>
            <span className="sr-only"> (change)</span>
          </>
        ) : (
          "Set your name"
        )}
      </button>
      <NameDialog
        open={open}
        currentName={name}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The right side of the top navigation: Sources, Settings, Status, and the
 * display name. At phone width the links fold into a "Menu" (native <details>).
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
        <NameButton name={name} />
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
            <NameButton name={name} wide />
          </div>
        </div>
      </details>
    </div>
  );
}
