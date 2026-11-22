"use client";

import { useState } from "react";

import {
  Button,
  ChipToggle,
  Dialog,
  Field,
  Input,
  SavedNote,
  SegmentedControl,
  SubmitButton,
  Switch,
} from "@/components/ui";

/** The interactive parts of the kit gallery (invented data only). */
export function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open a dialog</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Archive this feed?"
        description="Nobody sees an archived feed in the tabs. You can restore it in the shared settings."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon="delete" onClick={() => setOpen(false)}>
              Archive feed
            </Button>
          </>
        }
      >
        <p className="text-sm">The stories and the digests stay. This is a sample: nothing changes.</p>
      </Dialog>
    </>
  );
}

export function ToggleDemo() {
  const [topics, setTopics] = useState<Record<string, boolean>>({ "Coding agents": true, Evaluations: false, Orchestration: false });
  const [on, setOn] = useState(true);
  const [windowValue, setWindowValue] = useState<"today" | "week" | "month">("week");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {Object.entries(topics).map(([name, pressed]) => (
          <ChipToggle key={name} pressed={pressed} onClick={() => setTopics((t) => ({ ...t, [name]: !pressed }))}>
            {name}
          </ChipToggle>
        ))}
      </div>
      <Switch
        id="kit-switch-controlled"
        label="In this feed"
        description="A controlled switch with the state text."
        showState
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
      />
      <SegmentedControl
        label="Window (controlled radios)"
        name="kit-window-controlled"
        value={windowValue}
        onChange={setWindowValue}
        options={[
          { value: "today", label: "Today" },
          { value: "week", label: "7 days" },
          { value: "month", label: "30 days" },
        ]}
      />
    </div>
  );
}

export function SavedDemo() {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="primary"
        pending={pending}
        onClick={() => {
          setPending(true);
          setTimeout(() => {
            setPending(false);
            setSavedAt(Date.now());
          }, 700);
        }}
      >
        Save section
      </Button>
      <SavedNote at={savedAt} />
    </div>
  );
}

export function FormStatusDemo() {
  const [result, setResult] = useState<string | null>(null);
  return (
    <form
      action={async (formData: FormData) => {
        await new Promise((r) => setTimeout(r, 900));
        setResult(`Submitted: ${String(formData.get("kit-exclusion") ?? "")}`);
      }}
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
    >
      <Field id="kit-exclusion" label="Add an exclusion" className="sm:flex-1">
        <Input id="kit-exclusion" name="kit-exclusion" defaultValue="Beginner tutorials" />
      </Field>
      <SubmitButton icon="add" pendingLabel="Adding">
        Add
      </SubmitButton>
      {result ? <p className="text-sm text-muted sm:self-center">{result}</p> : null}
    </form>
  );
}
