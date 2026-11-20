import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";

export interface SwitchProps extends Omit<ComponentProps<"input">, "type" | "role"> {
  /** The visible text label (required: the switch is never only a color). */
  label: ReactNode;
  /** A short line under the label. */
  description?: ReactNode;
  /** Shows "On" / "Off" after the label. */
  showState?: boolean;
  className?: string;
}

/**
 * An on / off switch: a native checkbox with role="switch". It works in a plain
 * form (the value goes with `name` when on) and with the keyboard (Space).
 * `checked` with `onChange` makes it controlled; `defaultChecked` for a plain form.
 */
export function Switch({ label, description, showState = false, className, id, ...rest }: SwitchProps) {
  const on = rest.checked ?? rest.defaultChecked ?? false;
  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex min-h-10 cursor-pointer items-start gap-3 py-1 sm:min-h-8",
        rest.disabled && "cursor-not-allowed opacity-70",
        className,
      )}
    >
      <input id={id} type="checkbox" role="switch" className="ui-switch mt-0.5" {...rest} />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-fg">
          {label}
          {showState ? <span className="ml-1.5 font-normal text-muted">{on ? "On" : "Off"}</span> : null}
        </span>
        {description ? <span className="text-sm text-muted">{description}</span> : null}
      </span>
    </label>
  );
}
