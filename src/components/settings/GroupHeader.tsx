import type { ReactNode } from "react";

/** The title of one feed settings group (the h1 of the page; the feed name above is not a heading): a name, one line, and actions. */
export function GroupHeader({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 id="settings-group-title" className="font-serif text-2xl leading-tight font-semibold tracking-tight text-fg">
          {title}
        </h1>
        <p className="mt-1 max-w-prose text-sm text-pretty text-muted">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
