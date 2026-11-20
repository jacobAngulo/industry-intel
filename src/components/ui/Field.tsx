import type { ReactNode } from "react";

import { cn } from "./cn";
import { Icon } from "./Icon";

/** The ids of the hint and the error text of a field, for aria-describedby on its control. */
export function fieldDescribedBy(id: string, opts: { hint?: unknown; error?: unknown }): string | undefined {
  const ids = [opts.hint ? `${id}-hint` : null, opts.error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export interface FieldProps {
  /** The id of the control inside (the label points to it). */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Shows "(optional)" after the label. */
  optional?: boolean;
  /** Hides the label visually (it stays for screen readers). */
  labelHidden?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A label, the control, a hint, and an error. Give the control the same `id`,
 * `aria-describedby={fieldDescribedBy(id, { hint, error })}`, and `invalid={!!error}`.
 */
export function Field({ id, label, hint, error, optional = false, labelHidden = false, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium text-fg", labelHidden && "sr-only")}>
        {label}
        {optional ? <span className="font-normal text-muted"> (optional)</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm text-alert">
          <Icon name="error" size={14} className="mt-[3px]" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/** A group of related controls with a legend (radios, checkboxes, switches). */
export function FieldGroup({
  legend,
  hint,
  error,
  className,
  children,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className={cn("flex flex-col gap-2", className)}>
      <legend className="mb-1.5 text-sm font-medium text-fg">{legend}</legend>
      {hint ? <p className="-mt-1 text-sm text-muted">{hint}</p> : null}
      {children}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-alert">
          <Icon name="error" size={14} className="mt-[3px]" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
