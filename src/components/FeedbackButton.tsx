"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { submitFeedback } from "@/app/_lib/feedback-actions";
import { FEEDBACK_DESCRIPTION_MAX, FEEDBACK_TITLE_MAX } from "@/app/_lib/feedback";
import { Button, Field, Icon, Input, Select, Textarea, buttonClass, fieldDescribedBy } from "@/components/ui";

const newSubmissionId = () => globalThis.crypto?.randomUUID?.() ?? `feedback-${Date.now()}-${Math.random()}`;

/**
 * The "Feedback" button in the bottom right corner, the same as in the other
 * apps. It stays in view while the page scrolls. The panel is not modal: the
 * page stays usable, and a draft stays when the panel closes. A bug or a
 * feature request goes to the Ticket Board backlog of the project.
 */
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
  const launcherRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Opening the panel, or "Send another", puts the focus on the summary.
  useEffect(() => {
    if (open && !done) titleRef.current?.focus();
  }, [open, done]);

  const close = () => {
    setOpen(false);
    launcherRef.current?.focus();
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
  const headingId = `${id}-heading`;
  const panelId = `${id}-panel`;
  return (
    <div
      className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 sm:right-5 sm:bottom-5 print:hidden"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) close();
      }}
    >
      {open ? (
        <section
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          className="absolute right-0 bottom-full mb-2 max-h-[calc(100dvh-5.5rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-card border border-border bg-surface p-5 text-fg shadow-xl"
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id={headingId} className="font-serif text-xl leading-snug font-semibold">
                Send feedback
              </h2>
              <p className="mt-1.5 text-sm text-muted">
                Report a problem or suggest an improvement. Your name and email go with the request.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              className="-m-1.5 inline-flex min-h-10 min-w-10 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Icon name="close" size={18} />
              <span className="sr-only">Close feedback</span>
            </button>
          </div>
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
                  ref={titleRef}
                  id={titleId}
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
        </section>
      ) : null}
      <button
        ref={launcherRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className={buttonClass("primary", "sm", "shadow-lg")}
      >
        <Icon name="add" size={14} />
        Feedback
      </button>
    </div>
  );
}
