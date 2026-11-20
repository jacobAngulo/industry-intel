import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";

export interface TableProps extends ComponentProps<"table"> {
  /** A caption for screen readers and, unless `captionHidden`, on screen. */
  caption?: ReactNode;
  captionHidden?: boolean;
  /** Tighter rows. */
  dense?: boolean;
}

/** A data table with hairline row dividers. It scrolls sideways inside its box at phone width. */
export function Table({ caption, captionHidden = false, dense = false, className, children, ...rest }: TableProps) {
  return (
    <div className="w-full overflow-x-auto rounded-card border border-border bg-surface">
      <table
        data-dense={dense || undefined}
        className={cn("group/table w-full border-collapse text-left text-sm", className)}
        {...rest}
      >
        {caption ? (
          <caption className={cn("px-4 pt-3 pb-1 text-left text-sm text-muted", captionHidden && "sr-only")}>
            {caption}
          </caption>
        ) : null}
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...rest }: ComponentProps<"thead">) {
  return <thead className={cn("bg-surface-2 text-xs text-muted", className)} {...rest} />;
}

export function TBody({ className, ...rest }: ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-border", className)} {...rest} />;
}

export function Tr({ className, ...rest }: ComponentProps<"tr">) {
  return <tr className={cn("align-top", className)} {...rest} />;
}

export function Th({ className, scope = "col", ...rest }: ComponentProps<"th">) {
  return (
    <th
      scope={scope}
      className={cn(
        "px-4 py-2 font-medium whitespace-nowrap group-data-[dense]/table:px-3 group-data-[dense]/table:py-1.5",
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: ComponentProps<"td">) {
  return (
    <td
      className={cn("px-4 py-2.5 group-data-[dense]/table:px-3 group-data-[dense]/table:py-1.5", className)}
      {...rest}
    />
  );
}
