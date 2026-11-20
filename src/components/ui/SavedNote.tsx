import { cn } from "./cn";
import { Icon } from "./Icon";

export interface SavedNoteProps {
  /**
   * A value that changes at each save (for example the time of the save or a
   * counter). Null or 0 shows nothing. A new value shows the note again.
   */
  at: number | string | null;
  /** The text (default "Saved"). */
  text?: string;
  className?: string;
}

/** An inline "Saved" note that fades out after about 2.5 s. Screen readers hear it once (role="status"). */
export function SavedNote({ at, text = "Saved", className }: SavedNoteProps) {
  return (
    <span role="status" aria-live="polite" className={cn("inline-flex min-h-5 items-center", className)}>
      {at ? (
        // The key restarts the fade animation for each new save.
        <span key={String(at)} className="animate-saved-fade inline-flex items-center gap-1 text-sm text-success">
          <Icon name="check" size={14} />
          {text}
        </span>
      ) : null}
    </span>
  );
}
