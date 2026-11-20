import type { ReactNode } from "react";

import { Button, SavedNote, cn } from "@/components/ui";

export interface SettingsSectionProps {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** The heading level: h2 on the shared settings page, h3 inside a feed settings group. */
  as?: "h2" | "h3";
  className?: string;
  children: ReactNode;
}

/** One section of a settings page: a heading, a quiet description, and the content. Hairline above. */
export function SettingsSection({ id, title, description, as: As = "h2", className, children }: SettingsSectionProps) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className={cn("scroll-mt-6 border-t border-border pt-6", className)}>
      <As id={`${id}-title`} className={cn("font-semibold text-fg", As === "h2" ? "text-lg" : "text-base")}>
        {title}
      </As>
      {description ? <div className="mt-1 max-w-prose text-sm text-pretty text-muted">{description}</div> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export interface SaveRowProps {
  pending: boolean;
  savedAt: number;
  /** The message of a failure (role="alert"). */
  error?: string | null;
  label?: string;
  /** The text of the note after a save (default "Saved"). */
  savedText?: string;
  /** Disables the button (for example when nothing changed). */
  disabled?: boolean;
  className?: string;
}

/** The Save button of a section, the inline "Saved" note, and the failure message. */
export function SaveRow({ pending, savedAt, error, label = "Save", savedText, disabled = false, className }: SaveRowProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving" disabled={disabled}>
          {label}
        </Button>
        <SavedNote at={savedAt || null} text={savedText} />
      </div>
      <div role="alert" className="text-sm text-alert empty:hidden">
        {error ?? null}
      </div>
    </div>
  );
}
