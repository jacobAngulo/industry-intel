import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";

export interface CardProps extends ComponentProps<"div"> {
  /** "plain" = a hairline box on the surface color; "flat" = no border, used inside lists with dividers. */
  variant?: "plain" | "flat" | "inset";
  padding?: "none" | "sm" | "md";
}

const VARIANTS = {
  plain: "rounded-card border border-border bg-surface shadow-card",
  flat: "bg-transparent",
  inset: "rounded-card border border-border bg-surface-2",
};

const PADDING = { none: "", sm: "p-3 sm:p-4", md: "p-4 sm:p-6" };

/** A quiet box. Prefer hairline dividers and white space; use a card for a self-contained unit. */
export function Card({ variant = "plain", padding = "md", className, ...rest }: CardProps) {
  return <div className={cn(VARIANTS[variant], PADDING[padding], className)} {...rest} />;
}

/** The title row of a card or a page section. */
export function SectionHeader({
  title,
  description,
  actions,
  as: As = "h2",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <As
          className={cn(
            "text-fg",
            As === "h1" ? "font-serif text-2xl font-semibold tracking-tight sm:text-[1.75rem]" : "text-base font-semibold",
          )}
        >
          {title}
        </As>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
