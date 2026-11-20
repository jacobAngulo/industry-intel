import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./Icon";

const chipBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border leading-tight transition-colors";
// Interactive chips are 40 px high at phone width, 28 px from `sm` up.
const chipInteractive = "min-h-10 sm:min-h-7 px-3 text-sm no-underline";
const chipOff = "border-border bg-surface text-fg hover:bg-surface-2";
const chipOn = "border-accent bg-accent-soft text-accent font-medium";

export interface ChipProps {
  icon?: IconName;
  className?: string;
  children: ReactNode;
}

/** A static chip (a topic, a feed name). */
export function Chip({ icon, className, children }: ChipProps) {
  return (
    <span className={cn(chipBase, "min-h-6 border-border bg-surface-2 px-2.5 text-xs text-muted", className)}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export interface ChipLinkProps extends Omit<ComponentProps<typeof Link>, "className"> {
  /** Marks the chip as the current choice (aria-current="page" or the given value). */
  selected?: boolean;
  icon?: IconName;
  className?: string;
  children: ReactNode;
}

/** A chip that links somewhere, for example a filter in the URL. */
export function ChipLink({ selected = false, icon, className, children, ...rest }: ChipLinkProps) {
  return (
    <Link
      aria-current={selected ? "page" : undefined}
      className={cn(chipBase, chipInteractive, selected ? chipOn : chipOff, className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
      {selected ? <Icon name="check" size={14} /> : null}
    </Link>
  );
}

export interface ChipToggleProps extends Omit<ComponentProps<"button">, "type"> {
  pressed: boolean;
  icon?: IconName;
}

/** A chip that toggles a state (aria-pressed). Use it in a client component. */
export function ChipToggle({ pressed, icon, className, children, ...rest }: ChipToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(chipBase, chipInteractive, pressed ? chipOn : chipOff, "cursor-pointer", className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
      {pressed ? <Icon name="check" size={14} /> : null}
    </button>
  );
}
