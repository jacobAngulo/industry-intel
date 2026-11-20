import { relevanceLabel } from "@/lib/types";

import { cn } from "./cn";

const TONE = {
  High: { bar: "bg-accent", text: "text-accent" },
  Medium: { bar: "bg-muted", text: "text-fg" },
  Low: { bar: "bg-border-strong", text: "text-muted" },
} as const;

export interface MeterProps {
  /** Relevance 0..100. */
  value: number;
  /** The word before the number (default "Relevance"). Set null to hide it (keep it for screen readers). */
  label?: string | null;
  /** Hides the bar (number and label only). */
  compact?: boolean;
  className?: string;
}

/**
 * The relevance number with its label (High ≥ 80, Medium 60–79, Low < 60) and
 * a small bar. The text carries the value; the bar is extra.
 */
export function Meter({ value, label = "Relevance", compact = false, className }: MeterProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const level = relevanceLabel(v);
  const tone = TONE[level];
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      {label ? <span className="text-muted">{label}</span> : <span className="sr-only">Relevance</span>}
      <span className={cn("font-semibold tabular-nums", tone.text)}>{v}</span>
      <span className="text-muted">· {level}</span>
      {!compact ? (
        <span aria-hidden="true" className="relative h-1.5 w-12 overflow-hidden rounded-full bg-surface-2 ring-1 ring-border">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", tone.bar)} style={{ width: `${v}%` }} />
        </span>
      ) : null}
    </span>
  );
}
