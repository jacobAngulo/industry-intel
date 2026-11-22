"use client";

import { useState } from "react";

import { saveFeedProfileAction } from "@/app/f/[slug]/settings/actions";
import { Field, Input, Textarea, fieldDescribedBy } from "@/components/ui";

import { errorFor, textChanged, type RejudgeEstimate } from "./helpers";
import { RejudgeOffer } from "./RejudgeOffer";
import { SaveRow } from "./SettingsSection";
import { useSave } from "./use-save";

interface ProfileDraft {
  name: string;
  purpose: string;
  projectContext: string;
}

export interface FeedProfileFormProps {
  feedId: number;
  initial: ProfileDraft;
}

/** "This feed": name, purpose (one line), context (§4.8 Feed Profile). Purpose and context are judge-time. */
export function FeedProfileForm({ feedId, initial }: FeedProfileFormProps) {
  const save = useSave(saveFeedProfileAction);
  const [saved, setSaved] = useState<ProfileDraft>(initial);
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [offer, setOffer] = useState<RejudgeEstimate[] | null>(null);
  const err = (key: keyof ProfileDraft) => errorFor(save.failure?.fieldErrors, key);
  const set = (patch: Partial<ProfileDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <>
      <form
        id={save.formId}
        noValidate
        className="flex max-w-3xl flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setOffer(null);
          const sent = draft;
          void save.run({ feedId, ...sent }, (estimates) => {
            const judgeTimeChange =
              textChanged(saved.purpose, sent.purpose) || textChanged(saved.projectContext, sent.projectContext);
            setSaved(sent);
            if (judgeTimeChange) setOffer(estimates);
          });
        }}
      >
        <Field id="feed-name" label="Name" hint="The name of the feed tab. The address stays the same." error={err("name")}>
          <Input
            id="feed-name"
            required
            maxLength={120}
            value={draft.name}
            invalid={!!err("name")}
            aria-describedby={fieldDescribedBy("feed-name", { hint: true, error: err("name") })}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field id="feed-purpose" label="Purpose" hint="One line: what this feed is for." error={err("purpose")}>
          <Input
            id="feed-purpose"
            maxLength={300}
            value={draft.purpose}
            invalid={!!err("purpose")}
            aria-describedby={fieldDescribedBy("feed-purpose", { hint: true, error: err("purpose") })}
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </Field>
        <Field
          id="feed-context"
          label="Context"
          hint="The projects, tools, open decisions, and questions that this feed follows."
          error={err("projectContext")}
        >
          <Textarea
            id="feed-context"
            rows={5}
            maxLength={4000}
            value={draft.projectContext}
            placeholder="For example: the projects, the tools that they depend on, and the decisions that are open."
            invalid={!!err("projectContext")}
            aria-describedby={fieldDescribedBy("feed-context", { hint: true, error: err("projectContext") })}
            onChange={(e) => set({ projectContext: e.target.value })}
          />
        </Field>
        <SaveRow pending={save.pending} savedAt={save.savedAt} error={save.failure?.message} />
      </form>
      {offer ? <RejudgeOffer estimates={offer} onDismiss={() => setOffer(null)} /> : null}
    </>
  );
}
