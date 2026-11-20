import Link from "next/link";
import type { ChangeEvent } from "react";

import { cn } from "./cn";

export interface SegmentOption<V extends string = string> {
  value: V;
  label: string;
  /** Link mode: the address of this choice (for example `?window=today`). */
  href?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  /** Text label of the group (visible unless `labelHidden`). */
  label: string;
  labelHidden?: boolean;
  options: SegmentOption<V>[];
  /** The current value (link mode and controlled radio mode). */
  value?: V;
  /** Radio mode: the form field name. Without `href` on the options the control renders native radios. */
  name?: string;
  defaultValue?: V;
  onChange?: (value: V) => void;
  size?: "sm" | "md";
  className?: string;
}

const groupClass = "inline-flex flex-wrap items-stretch gap-0.5 rounded-control border border-border bg-surface-2 p-0.5";
const segmentClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-[4px] px-3 text-sm leading-tight transition-colors hover:text-fg";
const segmentOn = "bg-surface text-fg font-medium shadow-card ring-1 ring-border";
const segmentOff = "text-muted";

/**
 * A small set of exclusive choices. Two modes:
 * - Link mode (each option has `href`): links with aria-current on the current value. Works with no JavaScript.
 * - Radio mode (`name`): native radio buttons for a form, arrow keys move the choice.
 */
export function SegmentedControl<V extends string = string>({
  label,
  labelHidden = false,
  options,
  value,
  name,
  defaultValue,
  onChange,
  size = "md",
  className,
}: SegmentedControlProps<V>) {
  const height = size === "sm" ? "min-h-10 sm:min-h-7" : "min-h-10 sm:min-h-8";
  const linkMode = options.every((o) => o.href !== undefined);

  if (linkMode) {
    return (
      <nav aria-label={label} className={cn("flex flex-wrap items-center gap-2", className)}>
        {!labelHidden ? <span className="text-sm text-muted">{label}</span> : null}
        <ul className={groupClass}>
          {options.map((o) => {
            const current = o.value === value;
            return (
              <li key={o.value} className="flex">
                <Link
                  href={o.href ?? "#"}
                  aria-current={current ? "page" : undefined}
                  className={cn(segmentClass, height, "no-underline", current ? segmentOn : segmentOff)}
                >
                  {o.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  const handle = onChange ? (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value as V) : undefined;
  return (
    <fieldset className={cn("flex flex-wrap items-center gap-2", className)}>
      <legend className={cn("float-left mr-2 text-sm text-muted", labelHidden && "sr-only")}>{label}</legend>
      <div className={groupClass}>
        {options.map((o) => (
          <label key={o.value} className={cn("relative flex", o.disabled ? "cursor-not-allowed" : "cursor-pointer")}>
            <input
              type="radio"
              name={name}
              value={o.value}
              disabled={o.disabled}
              className="peer sr-only"
              {...(value !== undefined
                ? { checked: value === o.value, onChange: handle }
                : { defaultChecked: defaultValue === o.value, onChange: handle })}
            />
            <span
              className={cn(
                segmentClass,
                height,
                segmentOff,
                "peer-checked:bg-surface peer-checked:font-medium peer-checked:text-fg peer-checked:shadow-card peer-checked:ring-1 peer-checked:ring-border",
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
                "peer-disabled:opacity-50",
              )}
            >
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
