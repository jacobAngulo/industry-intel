"use client";

import { useState } from "react";

import { saveDefaultsAction } from "@/app/settings/actions";
import { Field, Input, Select, fieldDescribedBy } from "@/components/ui";
import {
  SUMMARY_LENGTHS,
  SUMMARY_LENGTH_LABELS,
  TECHNICAL_DEPTHS,
  TECHNICAL_DEPTH_LABELS,
  type BriefFormat,
  type FeedDefaults,
  type QuietHours,
  type SummaryLength,
  type TechnicalDepth,
} from "@/lib/types";

import { AlertFields, DigestFields, QuietHoursFields } from "./DeliveryFields";
import {
  alertsFromDraft,
  alertsToDraft,
  digestFromDraft,
  digestToDraft,
  errorFor,
  parseWholeNumber,
  type AlertDraft,
  type DigestDraft,
} from "./helpers";
import { PhraseListEditor } from "./PhraseListEditor";
import { SaveRow } from "./SettingsSection";
import { useSave, type SaveHandle } from "./use-save";

const VALIDATION_MESSAGE = "Some fields are not valid. Correct the marked fields and try again.";

interface Defaults {
  briefDefaults: BriefFormat;
  defaultExclusions: string[];
  feedDefaults: FeedDefaults;
}

type Section = "brief" | "exclusions" | "feed";

export interface DefaultsFormProps {
  initial: Defaults;
  /** IANA zones, the current default first. */
  timeZones: string[];
}

/**
 * §4.9 Defaults: the brief format defaults (every feed that follows the shared
 * default), the default exclusions of a new feed, and the values that a new feed starts from.
 */
export function DefaultsForm({ initial, timeZones }: DefaultsFormProps) {
  const [saved, setSaved] = useState<Defaults>(initial);
  const [brief, setBrief] = useState<BriefFormat>(initial.briefDefaults);
  const [exclusions, setExclusions] = useState<string[]>(initial.defaultExclusions);
  const fd = initial.feedDefaults;
  const [minRelevance, setMinRelevance] = useState(String(fd.minRelevance));
  const [halfLife, setHalfLife] = useState(String(fd.halfLifeHours));
  const [digest, setDigest] = useState<DigestDraft>(digestToDraft(fd.digest));
  const [quiet, setQuiet] = useState<QuietHours>(fd.quietHours);
  const [alerts, setAlerts] = useState<AlertDraft>(alertsToDraft(fd.alerts));

  const saves: Record<Section, SaveHandle<unknown, null>> = {
    brief: useSave(saveDefaultsAction),
    exclusions: useSave(saveDefaultsAction),
    feed: useSave(saveDefaultsAction),
  };

  const submit = (section: Section, patch: Partial<Defaults>) => {
    const next: Defaults = { ...saved, ...patch };
    void saves[section].run(next, () => setSaved(next));
  };

  const submitFeedDefaults = () => {
    const errors: Record<string, string> = {};
    const min = parseWholeNumber(minRelevance, 0, 100);
    if ("error" in min) errors["feedDefaults.minRelevance"] = min.error;
    const half = parseWholeNumber(halfLife, 1, 720);
    if ("error" in half) errors["feedDefaults.halfLifeHours"] = half.error;
    const d = digestFromDraft(digest, "feedDefaults.digest");
    if ("errors" in d) Object.assign(errors, d.errors);
    const a = alertsFromDraft(alerts, "feedDefaults.alerts");
    if ("errors" in a) Object.assign(errors, a.errors);
    if ("error" in min || "error" in half || "errors" in d || "errors" in a) {
      saves.feed.setFailure({ message: VALIDATION_MESSAGE, fieldErrors: errors });
      return;
    }
    submit("feed", {
      feedDefaults: {
        minRelevance: min.value,
        halfLifeHours: half.value,
        digest: d.value,
        quietHours: quiet,
        alerts: a.value,
      },
    });
  };

  const feedErrors = saves.feed.failure?.fieldErrors;
  const minError = errorFor(feedErrors, "feedDefaults.minRelevance");
  const halfError = errorFor(feedErrors, "feedDefaults.halfLifeHours");

  return (
    <div className="flex flex-col gap-8">
      <form
        id={saves.brief.formId}
        noValidate
        aria-labelledby="defaults-brief-title"
        className="flex max-w-3xl flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit("brief", { briefDefaults: brief });
        }}
      >
        <div>
          <h3 id="defaults-brief-title" className="font-semibold text-fg">
            Brief format
          </h3>
          <p className="text-sm text-muted">Every feed that uses “the shared default” for a setting follows these values.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="default-summary" label="Summary length">
            <Select
              id="default-summary"
              value={brief.summaryLength}
              options={SUMMARY_LENGTHS.map((v) => ({ value: v, label: SUMMARY_LENGTH_LABELS[v] }))}
              onChange={(e) => setBrief((b) => ({ ...b, summaryLength: e.target.value as SummaryLength }))}
            />
          </Field>
          <Field id="default-depth" label="Technical depth">
            <Select
              id="default-depth"
              value={brief.technicalDepth}
              options={TECHNICAL_DEPTHS.map((v) => ({ value: v, label: TECHNICAL_DEPTH_LABELS[v] }))}
              onChange={(e) => setBrief((b) => ({ ...b, technicalDepth: e.target.value as TechnicalDepth }))}
            />
          </Field>
          <Field id="default-actions" label="Suggested actions">
            <Select
              id="default-actions"
              value={brief.suggestedActions ? "on" : "off"}
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
              onChange={(e) => setBrief((b) => ({ ...b, suggestedActions: e.target.value === "on" }))}
            />
          </Field>
        </div>
        <SaveRow pending={saves.brief.pending} savedAt={saves.brief.savedAt} error={saves.brief.failure?.message} />
      </form>

      <form
        id={saves.exclusions.formId}
        noValidate
        aria-labelledby="defaults-exclusions-title"
        className="flex max-w-3xl flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit("exclusions", { defaultExclusions: exclusions });
        }}
      >
        <div>
          <h3 id="defaults-exclusions-title" className="font-semibold text-fg">
            Default exclusions for new feeds
          </h3>
          <p className="text-sm text-muted">A new feed starts with these exclusions. The existing feeds keep their own list.</p>
        </div>
        <PhraseListEditor
          id="default-exclusions"
          listLabel="Default exclusions"
          addLabel="Add a default exclusion"
          placeholder="A short phrase"
          emptyText="No default exclusion."
          value={exclusions}
          onChange={setExclusions}
          error={errorFor(saves.exclusions.failure?.fieldErrors, "defaultExclusions")}
        />
        <SaveRow
          pending={saves.exclusions.pending}
          savedAt={saves.exclusions.savedAt}
          error={saves.exclusions.failure?.message}
        />
      </form>

      <form
        id={saves.feed.formId}
        noValidate
        aria-labelledby="defaults-feed-title"
        className="flex max-w-3xl flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          submitFeedDefaults();
        }}
      >
        <div>
          <h3 id="defaults-feed-title" className="font-semibold text-fg">
            Values for new feeds
          </h3>
          <p className="text-sm text-muted">A new feed starts from these values. The existing feeds keep their own settings.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="default-min" label="Minimum relevance to show" hint="0 to 100." error={minError}>
            <Input
              id="default-min"
              inputMode="numeric"
              value={minRelevance}
              invalid={!!minError}
              aria-describedby={fieldDescribedBy("default-min", { hint: true, error: minError })}
              onChange={(e) => setMinRelevance(e.target.value)}
              className="max-w-32"
            />
          </Field>
          <Field id="default-half-life" label="Freshness half-life in hours" hint="1 to 720." error={halfError}>
            <Input
              id="default-half-life"
              inputMode="numeric"
              value={halfLife}
              invalid={!!halfError}
              aria-describedby={fieldDescribedBy("default-half-life", { hint: true, error: halfError })}
              onChange={(e) => setHalfLife(e.target.value)}
              className="max-w-32"
            />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold text-fg">Digest</legend>
          <DigestFields
            id="default-digest"
            value={digest}
            onChange={setDigest}
            timeZones={timeZones}
            errors={feedErrors}
            errorPrefix="feedDefaults.digest"
          />
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold text-fg">Quiet hours</legend>
          <QuietHoursFields
            id="default-quiet"
            value={quiet}
            onChange={setQuiet}
            timeZone={digest.timeZone}
            errors={feedErrors}
            errorPrefix="feedDefaults.quietHours"
          />
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold text-fg">Alerts</legend>
          <AlertFields
            id="default-alerts"
            value={alerts}
            onChange={setAlerts}
            errors={feedErrors}
            errorPrefix="feedDefaults.alerts"
          />
        </fieldset>
        <SaveRow pending={saves.feed.pending} savedAt={saves.feed.savedAt} error={saves.feed.failure?.message} />
      </form>
    </div>
  );
}
