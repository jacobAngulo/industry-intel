"use client";

import { useId, useRef, useState, useTransition } from "react";

import { submitFeedback } from "@/app/_lib/feedback-actions";
import { FEEDBACK_DESCRIPTION_MAX, FEEDBACK_TITLE_MAX } from "@/app/_lib/feedback";
import { Button, Dialog, Field, Input, Select, Textarea, fieldDescribedBy } from "@/components/ui";

const newSubmissionId = () => globalThis.crypto?.randomUUID?.() ?? `feedback-${Date.now()}-${Math.random()}`;

/** "Send feedback" in the footer: a bug or a feature request goes to the Ticket Board backlog of the project. */
export function FeedbackButton() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const submissionId = useRef(newSubmissionId());

  const close = () => {
    setOpen(false);
    setError(null);
    setFieldErrors({});
    setDone(null);
  };

  const submit = () => {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      try {
        const result = await submitFeedback({
          kind,
          title,
          description,
          submissionId: submissionId.current,
          pageUrl: window.location.href,
          pageTitle: document.title,
        });
        if (result.ok) {
          setDone(result.message ?? "Sent.");
          setTitle("");
          setDescription("");
          submissionId.current = newSubmissionId();
        } else {
          setError(result.message);
          setFieldErrors(result.fieldErrors ?? {});
        }
      } catch {
        setError("The feedback was not sent. Check the connection and try again.");
      }
    });
  };

  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-muted underline hover:text-fg">
        Send feedback
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Send feedback"
        description="Report a problem or suggest an improvement. It goes to the team's ticket board, with your display name."
        size="md"
      >
        {done ? (
          <div className="flex flex-col gap-4">
            <p role="status">{done}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDone(null)}>
                Send another
              </Button>
              <Button variant="primary" onClick={close}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              submit();
            }}
            className="flex flex-col gap-4"
          >
            {error && !Object.keys(fieldErrors).some((k) => k === "title" || k === "description") ? (
              <p role="alert" className="text-sm text-alert">
                {error}
              </p>
            ) : null}
            <Field id={`${id}-kind`} label="Request type">
              <Select
                id={`${id}-kind`}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                options={[
                  { value: "bug", label: "Bug" },
                  { value: "feature", label: "Feature request" },
                ]}
              />
            </Field>
            <Field id={titleId} label="Summary" error={fieldErrors.title}>
              <Input
                id={titleId}
                autoFocus
                required
                maxLength={FEEDBACK_TITLE_MAX}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                invalid={!!fieldErrors.title}
                aria-describedby={fieldDescribedBy(titleId, { error: fieldErrors.title })}
              />
            </Field>
            <Field id={descriptionId} label="Details" optional error={fieldErrors.description}>
              <Textarea
                id={descriptionId}
                rows={5}
                maxLength={FEEDBACK_DESCRIPTION_MAX}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                invalid={!!fieldErrors.description}
                aria-describedby={fieldDescribedBy(descriptionId, { error: fieldErrors.description })}
              />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" pending={pending} pendingLabel="Sending">
                Send feedback
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
