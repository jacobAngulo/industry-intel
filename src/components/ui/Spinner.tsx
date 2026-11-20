import { cn } from "./cn";

export interface SpinnerProps {
  /** Size in px (default 16). */
  size?: number;
  /** Text for screen readers (default "Loading"). Set `label={null}` when visible text says it already. */
  label?: string | null;
  className?: string;
}

/** A small rotating ring. */
export function Spinner({ size = 16, label = "Loading", className }: SpinnerProps) {
  return (
    <span role={label ? "status" : undefined} className={cn("inline-flex items-center", className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite]"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
