import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon } from "./Icon";

export interface DisclosureProps {
  /** The text of the toggle (the <summary>). */
  summary: ReactNode;
  defaultOpen?: boolean;
  /** "inline": a small text toggle (for example "Why this ranks here"); "box": a bordered section. */
  variant?: "inline" | "box";
  className?: string;
  children: ReactNode;
}

/** Content that opens and closes, over the native <details> element (works with no JavaScript). */
export function Disclosure({ summary, defaultOpen = false, variant = "inline", className, children }: DisclosureProps) {
  return (
    <details
      open={defaultOpen || undefined}
      className={cn(variant === "box" && "rounded-card border border-border bg-surface", className)}
    >
      <summary
        className={cn(
          "ui-summary inline-flex min-h-10 items-center gap-1.5 rounded-control text-sm select-none sm:min-h-8",
          variant === "inline" ? "text-muted hover:text-fg" : "w-full px-4 font-medium text-fg",
        )}
      >
        <Icon name="chevronRight" size={14} className="ui-summary-chevron transition-transform" />
        {summary}
      </summary>
      <div className={cn(variant === "inline" ? "pt-2 pb-1 pl-5" : "border-t border-border px-4 py-3")}>{children}</div>
    </details>
  );
}
