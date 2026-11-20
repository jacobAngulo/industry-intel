"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "./cn";
import { Icon } from "./Icon";

export interface DialogProps {
  open: boolean;
  /** Called when the dialog closes (Escape, the close button, a click on the backdrop). Set `open` to false. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** The action row (buttons) at the bottom. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Close on a click outside the panel (default true). */
  closeOnBackdrop?: boolean;
  /** The text of the close button for screen readers (default "Close"). */
  closeLabel?: string;
  className?: string;
}

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };

/**
 * A modal dialog over the native <dialog> element (showModal): the browser
 * traps the focus and Escape closes it. When it closes, the focus goes back to
 * the element that had it before.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  closeLabel = "Close",
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target && target.isConnected) target.focus();
      onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, []);

  // Close an open dialog when the component goes away (for example after a navigation).
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) e.currentTarget.close();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-card border border-border bg-surface p-0 text-fg shadow-xl",
        "backdrop:backdrop-blur-[1px]",
        SIZES[size],
        className,
      )}
    >
      {open ? (
        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id={titleId} className="font-serif text-xl font-semibold leading-snug">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="mt-1.5 text-sm text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="-m-1.5 inline-flex min-h-10 min-w-10 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Icon name="close" size={18} />
              <span className="sr-only">{closeLabel}</span>
            </button>
          </div>
          {children}
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
