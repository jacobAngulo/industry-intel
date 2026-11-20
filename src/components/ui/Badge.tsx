import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./Icon";

export type BadgeTone = "neutral" | "accent" | "alert" | "warning" | "success";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  accent: "bg-accent-soft text-accent border-accent/25",
  alert: "bg-alert-soft text-alert border-alert/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  success: "bg-success-soft text-success border-success/30",
};

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: IconName;
  /** Small caps style for marks such as ALERT. */
  strong?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}

/** A short status label. The text carries the meaning; the color is extra. */
export function Badge({ tone = "neutral", icon, strong = false, className, title, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-xs font-medium leading-5",
        strong && "font-semibold uppercase tracking-wide",
        TONES[tone],
        className,
      )}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}
