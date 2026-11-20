import { clsx, type ClassValue } from "clsx";

/** Joins class names (clsx). */
export function cn(...values: ClassValue[]): string {
  return clsx(values);
}

/**
 * Shared class strings of the kit. Controls are at least 40 px high at phone
 * width (touch target) and can be smaller from the `sm` breakpoint up.
 */
export const controlBase =
  "block w-full rounded-control border border-border-strong bg-surface px-3 text-fg placeholder:text-muted/80 " +
  "transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-alert";

export const controlHeight = "min-h-10 sm:min-h-9";
