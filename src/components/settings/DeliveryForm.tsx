"use client";

import { useState } from "react";

import { archiveFeedAction, saveFeedDeliveryAction } from "@/app/f/[slug]/settings/actions";
import { Button, Dialog, Field, Select, fieldDescribedBy } from "@/components/ui";
import {
  SUMMARY_LENGTHS,
  SUMMARY_LENGTH_LABELS,
  TECHNICAL_DEPTHS,
  TECHNICAL_DEPTH_LABELS,
  type AlertSettings,
  type BriefFormat,
  type BriefFormatOverride,
  type DigestSettings,
  type QuietHours,
} from "@/lib/types";

import { AlertFields, DigestFields, QuietHoursFields } from "./DeliveryFields";
import {
  alertsFromDraft,
  alertsToDraft,
  defaultOptionLabel,
  digestFromDraft,
  digestToDraft,
  errorFor,
  fromChoice,
  fromOnOffChoice,
  textChanged,
  toChoice,
  type AlertDraft,
  type DigestDraft,
  type RejudgeEstimate,
} from "./helpers";
import { RejudgeOffer } from "./RejudgeOffer";
import { SaveRow, SettingsSection } from "./SettingsSection";
import { useSave, type SaveHandle } from "./use-save";

const VALIDATION_MESSAGE = "Some fields are not valid. Correct the marked fields and try again.";

interface Delivery {
  briefFormat: BriefFormatOverride;
  digest: DigestSettings;
  quietHours: QuietHours;
  alerts: AlertSettings;
}

export interface DeliveryFormProps {
  feedId: number;
  feedName: string;
  initial: Delivery;
  /** The shared brief format defaults (shown in the "Use the shared default (…)" options). */
  briefDefaults: BriefFormat;
  /** IANA zones, the current value first. */
  timeZones: string[];
}

type Section = "brief" | "digest" | "quiet" | "alerts";

/**
 * The Delivery group (§4.8). Each section has its own Save; a save sends only
 * the key of its section (a FeedDeliveryPatch).
 */
export function DeliveryForm({ feedId, feedName, initial, briefDefaults, timeZones }: DeliveryFormProps) {
  const [saved, setSaved] = useState<Delivery>(initial);
  const [brief, setBrief] = useState<BriefFormatOverride>(initial.briefFormat);
  const [digest, setDigest] = useState<DigestDraft>(digestToDraft(initial.digest));
  const [quiet, setQuiet] = useState<QuietHours>(initial.quietHours);
  const [alerts, setAlerts] = useState<AlertDraft>(alertsToDraft(initial.alerts));
  const [offer, setOffer] = useState<RejudgeEstimate[] | null>(null);

  const saves: Record<Section, SaveHandle<unknown, RejudgeEstimate[]>> = {
    brief: useSave(saveFeedDeliveryAction),
    digest: useSave(saveFeedDeliveryAction),
    quiet: useSave(saveFeedDeliveryAction),
    alerts: useSave(saveFeedDeliveryAction),
  };

  const submit = (section: Section, patch: Partial<Delivery>, offerRejudge: boolean) => {
    if (section === "brief") setOffer(null);
    void saves[section].run({ feedId, ...patch }, (estimates) => {
      setSaved((s) => ({ ...s, ...patch }));
      if (offerRejudge) setOffer(estimates);
    });
  };

  const briefErrors = saves.brief.failure?.fieldErrors;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        id="brief-format"
        as="h2"
        title="Brief format"
        description="How the stories of this feed read. Each setting can follow the shared default."
      >
        <form
          id={saves.brief.formId}
          noValidate
          className="grid max-w-3xl gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit("brief", { briefFormat: brief }, brief.technicalDepth !== saved.briefFormat.technicalDepth);
          }}
        >
          <Field
            id="summary-length"
            label="Summary length"
            hint="Short shows 1 sentence, Standard 3, Detailed 5."
            error={errorFor(briefErrors, "briefFormat.summaryLength")}
          >
            <Select
              id="summary-length"
              value={toChoice(brief.summaryLength)}
              aria-describedby={fieldDescribedBy("summary-length", { hint: true })}
              onChange={(e) => setBrief((b) => ({ ...b, summaryLength: fromChoice(e.target.value, SUMMARY_LENGTHS) }))}
              options={[
                { value: "default", label: defaultOptionLabel(SUMMARY_LENGTH_LABELS[briefDefaults.summaryLength]) },
                ...SUMMARY_LENGTHS.map((v) => ({ value: v, label: SUMMARY_LENGTH_LABELS[v] })),
              ]}
            />
          </Field>
          <Field
            id="technical-depth"
            label="Technical depth"
            hint="The model writes for this depth. Stories below it rank lower."
            error={errorFor(briefErrors, "briefFormat.technicalDepth")}
          >
            <Select
              id="technical-depth"
              value={toChoice(brief.technicalDepth)}
              aria-describedby={fieldDescribedBy("technical-depth", { hint: true })}
              onChange={(e) =>
                setBrief((b) => ({ ...b, technicalDepth: fromChoice(e.target.value, TECHNICAL_DEPTHS) }))
              }
              options={[
                { value: "default", label: defaultOptionLabel(TECHNICAL_DEPTH_LABELS[briefDefaults.technicalDepth]) },
                ...TECHNICAL_DEPTHS.map((v) => ({ value: v, label: TECHNICAL_DEPTH_LABELS[v] })),
              ]}
            />
          </Field>
          <Field
            id="suggested-actions"
            label="Suggested actions"
            hint="A one-line next step on each story, and actions in the deeper analysis."
            error={errorFor(briefErrors, "briefFormat.suggestedActions")}
          >
            <Select
              id="suggested-actions"
              value={toChoice(brief.suggestedActions)}
              aria-describedby={fieldDescribedBy("suggested-actions", { hint: true })}
              onChange={(e) => setBrief((b) => ({ ...b, suggestedActions: fromOnOffChoice(e.target.value) }))}
              options={[
                { value: "default", label: defaultOptionLabel(briefDefaults.suggestedActions ? "On" : "Off") },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          </Field>
          <SaveRow
            className="sm:col-span-3"
            pending={saves.brief.pending}
            savedAt={saves.brief.savedAt}
            error={saves.brief.failure?.message}
          />
        </form>
        {offer ? <RejudgeOffer estimates={offer} onDismiss={() => setOffer(null)} /> : null}
      </SettingsSection>

      <SettingsSection
        id="digest"
        as="h2"
        title="Digest"
        description="A digest is a stored list of the top stories of one period. It shows on the Digests tab."
      >
        <form
          id={saves.digest.formId}
          noValidate
          className="flex max-w-3xl flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = digestFromDraft(digest);
            if ("errors" in parsed) {
              saves.digest.setFailure({ message: VALIDATION_MESSAGE, fieldErrors: parsed.errors });
              return;
            }
            submit("digest", { digest: parsed.value }, false);
          }}
        >
          <DigestFields
            id="digest"
            value={digest}
            onChange={setDigest}
            timeZones={timeZones}
            errors={saves.digest.failure?.fieldErrors}
          />
          <SaveRow pending={saves.digest.pending} savedAt={saves.digest.savedAt} error={saves.digest.failure?.message} />
        </form>
      </SettingsSection>

      <SettingsSection id="quiet-hours" as="h2" title="Quiet hours">
        <form
          id={saves.quiet.formId}
          noValidate
          className="flex max-w-3xl flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit("quiet", { quietHours: quiet }, false);
          }}
        >
          <QuietHoursFields
            id="quiet"
            value={quiet}
            onChange={setQuiet}
            timeZone={saved.digest.timeZone}
            errors={saves.quiet.failure?.fieldErrors}
          />
          <SaveRow pending={saves.quiet.pending} savedAt={saves.quiet.savedAt} error={saves.quiet.failure?.message} />
        </form>
      </SettingsSection>

      <SettingsSection id="alerts" as="h2" title="Alerts">
        <form
          id={saves.alerts.formId}
          noValidate
          className="flex max-w-3xl flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = alertsFromDraft(alerts);
            if ("errors" in parsed) {
              saves.alerts.setFailure({ message: VALIDATION_MESSAGE, fieldErrors: parsed.errors });
              return;
            }
            submit("alerts", { alerts: parsed.value }, false);
          }}
        >
          <AlertFields id="alerts" value={alerts} onChange={setAlerts} errors={saves.alerts.failure?.fieldErrors} />
          {textChanged(saved.alerts.rule, alerts.rule) ? (
            <p className="text-sm text-muted">A new rule applies to new stories.</p>
          ) : null}
          <SaveRow pending={saves.alerts.pending} savedAt={saves.alerts.savedAt} error={saves.alerts.failure?.message} />
        </form>
      </SettingsSection>

      <ArchiveFeed feedId={feedId} feedName={feedName} />
    </div>
  );
}

function ArchiveFeed({
  feedId,
  feedName,
}: {
  feedId: number;
  feedName: string;
}) {
  const [open, setOpen] = useState(false);
  const save = useSave(archiveFeedAction);

  return (
    <SettingsSection
      id="archive"
      as="h2"
      title="Archive this feed"
      description="An archived feed leaves the tabs and gets no new judgements. Its stories, digests, and settings stay. You can restore it in the shared settings."
    >
      <Button
        variant="danger"
        icon="delete"
        onClick={() => setOpen(true)}
      >
        Archive this feed
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Archive ${feedName}?`}
        description="Nobody sees an archived feed in the tabs, and the worker stops judging for it. You can restore it in the shared settings."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={save.pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="delete"
              pending={save.pending}
              pendingLabel="Archiving"
              onClick={() => void save.run({ feedId })}
            >
              Archive feed
            </Button>
          </>
        }
      >
        {save.failure ? (
          <p role="alert" className="text-sm text-alert">
            {save.failure.message}
          </p>
        ) : null}
      </Dialog>
    </SettingsSection>
  );
}
