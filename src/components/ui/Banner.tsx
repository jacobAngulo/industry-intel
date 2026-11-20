import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./Icon";

export type BannerTone = "info" | "warning" | "alert";

const TONES: Record<BannerTone, { box: string; icon: IconName; iconClass: string; label: string }> = {
  info: { box: "border-border bg-surface-2 text-fg", icon: "info", iconClass: "text-accent", label: "Note" },
  warning: { box: "border-warning/30 bg-warning-soft text-fg", icon: "warning", iconClass: "text-warning", label: "Warning" },
  alert: { box: "border-alert/30 bg-alert-soft text-fg", icon: "alert", iconClass: "text-alert", label: "Alert" },
};

export interface BannerProps {
  tone?: BannerTone;
  /** A bold first line. */
  title?: ReactNode;
  children?: ReactNode;
  link?: { href: string; label: string };
  /** Buttons or links on the right (or below at phone width). */
  actions?: ReactNode;
  /** "thin": one compact line (the app-wide banner). */
  density?: "normal" | "thin";
  className?: string;
}

/** A message about a state of the app (§13). The icon and a hidden word say the tone; color is extra. */
export function Banner({ tone = "info", title, children, link, actions, density = "normal", className }: BannerProps) {
  const t = TONES[tone];
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-card border sm:flex-row sm:items-center sm:justify-between",
        density === "thin" ? "px-3 py-2 text-sm" : "px-4 py-3",
        t.box,
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon name={t.icon} size={density === "thin" ? 16 : 18} className={cn("mt-[3px]", t.iconClass)} />
        <div className="min-w-0">
          <span className="sr-only">{t.label}: </span>
          {title ? <p className="font-medium">{title}</p> : null}
          {children ? <div className={cn(title && "mt-0.5 text-sm", "text-pretty")}>{children}</div> : null}
          {link ? (
            <Link href={link.href} className="mt-0.5 inline-block text-sm font-medium text-accent underline">
              {link.label}
            </Link>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 pl-7 sm:pl-0">{actions}</div> : null}
    </div>
  );
}
