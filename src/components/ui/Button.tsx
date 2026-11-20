import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary: "bg-surface text-fg border border-border-strong hover:bg-surface-2",
  ghost: "bg-transparent text-fg border border-transparent hover:bg-surface-2",
  danger: "bg-surface text-alert border border-alert/60 hover:bg-alert-soft",
};

const SIZES: Record<ButtonSize, string> = {
  // At phone width every button is at least 40 px high.
  sm: "min-h-10 sm:min-h-8 px-3 text-sm gap-1.5",
  md: "min-h-10 px-4 text-[0.9375rem] gap-2",
};

/** The class string of a button. Use it for an element that must look like a button. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cn(
    "inline-flex select-none items-center justify-center whitespace-nowrap rounded-control font-medium leading-tight",
    "transition-colors disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy, and blocks a second click. */
  pending?: boolean;
  /** Text for screen readers while pending (default: the button text stays). */
  pendingLabel?: string;
  icon?: IconName;
  iconEnd?: IconName;
}

/** A button. Always give it a text label; an icon is extra. Default type is "button". */
export function Button({
  variant = "secondary",
  size = "md",
  pending = false,
  pendingLabel,
  icon,
  iconEnd,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? (
        <Spinner size={iconSize} label={pendingLabel ?? null} />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
      {iconEnd && !pending ? <Icon name={iconEnd} size={iconSize} /> : null}
    </button>
  );
}

export interface LinkButtonProps extends Omit<ComponentProps<typeof Link>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconEnd?: IconName;
  className?: string;
  /** Opens an external http(s) address in a new tab with rel="noopener noreferrer nofollow". */
  external?: boolean;
  children: ReactNode;
}

/** A link that looks like a button (navigation, not an action). */
export function LinkButton({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  className,
  external = false,
  children,
  href,
  ...rest
}: LinkButtonProps) {
  const iconSize = size === "sm" ? 14 : 16;
  const content = (
    <>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
      {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </>
  );
  if (external) {
    const url = typeof href === "string" ? href : "";
    return (
      <a
        href={/^https?:\/\//i.test(url) ? url : undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={buttonClass(variant, size, cn("no-underline", className))}
      >
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size, cn("no-underline", className))} {...rest}>
      {content}
    </Link>
  );
}
