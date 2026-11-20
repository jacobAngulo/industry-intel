import type { ReactNode } from "react";

import { cn } from "./cn";

export interface PageContainerProps {
  /** "reading" (max 860 px) for feed, story, and digest pages; "wide" (max 1120 px) for the directory and settings. */
  width?: "reading" | "wide";
  className?: string;
  children: ReactNode;
}

/** The content column of a page (§15). 16 px side gutter at phone width. */
export function PageContainer({ width = "reading", className, children }: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pt-6 pb-10 sm:px-6 sm:pt-10",
        width === "reading" ? "max-w-[860px]" : "max-w-[1120px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title (for example the feed purpose). */
  description?: ReactNode;
  /** Buttons or links on the right (below the title at phone width). */
  actions?: ReactNode;
  /** A small line above the title (for example a back link). */
  eyebrow?: ReactNode;
  className?: string;
}

/** The title block of a page: a serif h1 and a quiet description. */
export function PageHeader({ title, description, actions, eyebrow, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-sm text-muted">{eyebrow}</div> : null}
        <h1 className="font-serif text-[1.75rem] leading-tight font-semibold tracking-tight text-balance text-fg sm:text-[2rem]">
          {title}
        </h1>
        {description ? <p className="mt-2 max-w-prose text-pretty text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
