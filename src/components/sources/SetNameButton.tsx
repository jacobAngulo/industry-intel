"use client";

import { useNameGate } from "@/components/NameGate";
import { Button } from "@/components/ui";

/** Opens the name dialog; after the save the page refreshes. */
export function SetNameButton({ label = "Set your name" }: { label?: string }) {
  const { ensureName, dialog } = useNameGate(null);
  return (
    <>
      <Button size="sm" icon="user" onClick={() => void ensureName()}>
        {label}
      </Button>
      {dialog}
    </>
  );
}
