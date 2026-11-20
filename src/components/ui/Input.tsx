import type { ComponentProps, ReactNode } from "react";

import { cn, controlBase, controlHeight } from "./cn";

export interface InputProps extends ComponentProps<"input"> {
  /** Sets aria-invalid (red border). */
  invalid?: boolean;
}

/** A one-line text input. */
export function Input({ invalid, className, type = "text", ...rest }: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(controlBase, controlHeight, "py-1.5", className)}
      {...rest}
    />
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  invalid?: boolean;
}

/** A multi-line text input. */
export function Textarea({ invalid, className, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(controlBase, "min-h-20 py-2 leading-normal", className)}
      {...rest}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<"select">, "children"> {
  invalid?: boolean;
  /** The options. Or give `children` (<option> elements). */
  options?: SelectOption[];
  children?: ReactNode;
}

/** A native select with the kit look. */
export function Select({ invalid, className, options, children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cn(controlBase, controlHeight, "cursor-pointer appearance-none py-1.5 pr-9", className)}
        {...rest}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted"
      >
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}
