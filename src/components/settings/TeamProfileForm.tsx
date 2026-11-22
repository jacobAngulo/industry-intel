"use client";

import { useState } from "react";

import { saveTeamProfileAction } from "@/app/settings/actions";
import { Field, Textarea, fieldDescribedBy } from "@/components/ui";
import type { TeamProfile } from "@/lib/types";

import { errorFor, textChanged, type RejudgeEstimate } from "./helpers";
import { RejudgeOffer } from "./RejudgeOffer";
import { SaveRow } from "./SettingsSection";
import { useSave } from "./use-save";

const FIELDS: Array<{ key: keyof TeamProfile; label: string; placeholder: string; rows: number }> = [
  {
    key: "whatWeDo",
    label: "Focus",
    placeholder: "The domain and the kind of work that all feeds cover.",
    rows: 3,
  },
  {
    key: "constraints",
    label: "Requirements",
    placeholder: "Conditions that a tool or method must meet, for example “data stays in the EU” or “self-hosted only”.",
    rows: 3,
  },
];

export interface TeamProfileFormProps {
  profile: TeamProfile;
  /** The id prefix of the controls (unique on the page). */
  id?: string;
}

/**
 * The shared feed profile (§4.8, §4.9). It is judge-time for every feed: after
 * a save of a change, the form offers the re-judge for each active feed.
 */
export function TeamProfileForm({ profile, id = "team" }: TeamProfileFormProps) {
  const save = useSave(saveTeamProfileAction);
  const [saved, setSaved] = useState<TeamProfile>(profile);
  const [draft, setDraft] = useState<TeamProfile>(profile);
  const [offer, setOffer] = useState<RejudgeEstimate[] | null>(null);

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
          void save.run(sent, (estimates) => {
            const anyChange = FIELDS.some((f) => textChanged(saved[f.key], sent[f.key]));
            setSaved(sent);
            if (anyChange) setOffer(estimates);
          });
        }}
      >
        {FIELDS.map((f) => {
          const fieldId = `${id}-${f.key}`;
          const error = errorFor(save.failure?.fieldErrors, f.key);
          return (
            <Field key={f.key} id={fieldId} label={f.label} error={error}>
              <Textarea
                id={fieldId}
                rows={f.rows}
                maxLength={4000}
                value={draft[f.key]}
                placeholder={f.placeholder}
                invalid={!!error}
                aria-describedby={fieldDescribedBy(fieldId, { error })}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </Field>
          );
        })}
        <SaveRow
          pending={save.pending}
          savedAt={save.savedAt}
          error={save.failure?.message}
        />
      </form>
      {offer ? <RejudgeOffer estimates={offer} onDismiss={() => setOffer(null)} /> : null}
    </>
  );
}
