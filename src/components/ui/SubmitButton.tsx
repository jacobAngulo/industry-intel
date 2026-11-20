"use client";

import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "./Button";

/**
 * A submit button that shows the pending state of its form (React useFormStatus).
 * Use it inside a <form action={serverAction}>.
 */
export function SubmitButton({ pending, variant = "primary", ...rest }: Omit<ButtonProps, "type">) {
  const status = useFormStatus();
  return <Button type="submit" variant={variant} pending={pending || status.pending} {...rest} />;
}
