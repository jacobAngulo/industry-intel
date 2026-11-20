import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./Icon";

export interface EmptyStateProps {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links. */
  actions?: ReactNode;
  /** More content below (for example a list of suggestions). */
  children?: ReactNode;
  /** The heading level of the title (default h2). */
  as?: "h1" | "h2" | "h3";
  className?: string;
}

/** What a page or a list shows when it has nothing yet, with the next step. */
export function EmptyState({ icon, title, description, actions, children, as: As = "h2", className }: EmptyStateProps) {
  return (
    <section
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong px-5 py-10 text-center sm:px-10 sm:py-14",
        className,
      )}
    >
      {icon ? (
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      <As className="font-serif text-xl font-semibold text-fg">{title}</As>
      {description ? <div className="max-w-prose text-pretty text-muted">{description}</div> : null}
      {actions ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
      {children ? <div className="mt-4 w-full text-left">{children}</div> : null}
    </section>
  );
}
