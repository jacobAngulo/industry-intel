"use client";

import { useState } from "react";

import { archiveTopicAction, updateTopicAction } from "@/app/settings/actions";
import { Button, Dialog, Field, Input, fieldDescribedBy } from "@/components/ui";

import { errorFor, type RejudgeEstimate } from "./helpers";
import { AddTopicForm } from "./InterestsForm";
import { RejudgeOffer } from "./RejudgeOffer";
import { SaveRow } from "./SettingsSection";
import { useSave } from "./use-save";

export interface ManagedTopic {
  id: number;
  name: string;
  description: string;
}

export interface TopicsManagerProps {
  topics: ManagedTopic[];
  archivedNames: string[];
}

/** §4.9 Topics: add, rename, edit the description, archive. */
export function TopicsManager({ topics, archivedNames }: TopicsManagerProps) {
  const [offer, setOffer] = useState<RejudgeEstimate[] | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {topics.length === 0 ? (
        <p className="text-sm text-muted">No topic yet. Add the first one below.</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {topics.map((topic) => (
            <TopicRow key={topic.id} topic={topic} />
          ))}
        </ul>
      )}
      {archivedNames.length > 0 ? (
        <p className="text-sm text-muted">Archived topics (no longer used in the rank): {archivedNames.join(", ")}.</p>
      ) : null}
      <AddTopicForm idPrefix="shared-new-topic" onAdded={setOffer} />
      {offer ? <RejudgeOffer estimates={offer} onDismiss={() => setOffer(null)} /> : null}
    </div>
  );
}

function TopicRow({ topic }: { topic: ManagedTopic }) {
  const save = useSave(updateTopicAction);
  const archive = useSave(archiveTopicAction);
  const [draft, setDraft] = useState({ name: topic.name, description: topic.description });
  const [confirm, setConfirm] = useState(false);
  const id = `topic-${topic.id}`;
  const nameError = errorFor(save.failure?.fieldErrors, "name");
  const descriptionError = errorFor(save.failure?.fieldErrors, "description");

  return (
    <li className="py-4">
      <form
        id={save.formId}
        noValidate
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run({ id: topic.id, ...draft });
        }}
      >
        <Field
          id={`${id}-name`}
          label={
            <>
              Name<span className="sr-only"> of the topic {topic.name}</span>
            </>
          }
          error={nameError}
        >
          <Input
            id={`${id}-name`}
            required
            maxLength={120}
            value={draft.name}
            invalid={!!nameError}
            aria-describedby={fieldDescribedBy(`${id}-name`, { error: nameError })}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field
          id={`${id}-description`}
          label={
            <>
              Description<span className="sr-only"> of the topic {topic.name}</span>
            </>
          }
          error={descriptionError}
        >
          <Input
            id={`${id}-description`}
            maxLength={300}
            value={draft.description}
            invalid={!!descriptionError}
            aria-describedby={fieldDescribedBy(`${id}-description`, { error: descriptionError })}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>
        <div className="flex flex-wrap items-start justify-between gap-3 sm:col-span-2">
          <SaveRow pending={save.pending} savedAt={save.savedAt} error={save.failure?.message} />
          <Button
            variant="ghost"
            size="sm"
            icon="hide"
            onClick={() => setConfirm(true)}
          >
            Archive<span className="sr-only"> the topic {topic.name}</span>
          </Button>
        </div>
      </form>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Archive the topic “${topic.name}”?`}
        description="The topic leaves every feed: its priorities no longer count, and the model no longer offers it. Stories keep their judgements. The app has no way to restore an archived topic."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={archive.pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              pending={archive.pending}
              pendingLabel="Archiving"
              onClick={() => void archive.run({ id: topic.id }, () => setConfirm(false))}
            >
              Archive topic
            </Button>
          </>
        }
      >
        {archive.failure ? (
          <p role="alert" className="text-sm text-alert">
            {archive.failure.message}
          </p>
        ) : null}
      </Dialog>
    </li>
  );
}
