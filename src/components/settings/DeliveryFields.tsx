"use client";

import {
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  fieldDescribedBy,
} from "@/components/ui";
import { DIGEST_FREQUENCIES, DIGEST_FREQUENCY_LABELS, WEEKDAY_LABELS, type DigestFrequency, type QuietHours } from "@/lib/types";

import { errorFor, type AlertDraft, type DigestDraft } from "./helpers";

type Errors = Record<string, string> | undefined;

const FREQUENCY_OPTIONS = DIGEST_FREQUENCIES.map((value) => ({ value, label: DIGEST_FREQUENCY_LABELS[value] }));
const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({ value: String(value), label }));

export interface DigestFieldsProps {
  id: string;
  value: DigestDraft;
  onChange: (next: DigestDraft) => void;
  /** The IANA zones, the current value first. */
  timeZones: string[];
  errors?: Errors;
  /** The key prefix of the field errors ("digest" or "feedDefaults.digest"). */
  errorPrefix?: string;
}

/** Digest schedule: frequency, weekday (weekly only), time, time zone, maximum stories. */
export function DigestFields({ id, value, onChange, timeZones, errors, errorPrefix = "digest" }: DigestFieldsProps) {
  const set = (patch: Partial<DigestDraft>) => onChange({ ...value, ...patch });
  const err = (key: string) => errorFor(errors, `${errorPrefix}.${key}`);
  const off = value.frequency === "off";
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl<DigestFrequency>
        label="Frequency"
        name={`${id}-frequency`}
        options={FREQUENCY_OPTIONS}
        value={value.frequency}
        onChange={(frequency) => set({ frequency })}
      />
      {off ? <p className="text-sm text-muted">No digest is made. The settings below stay for later.</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {value.frequency === "weekly" ? (
          <Field id={`${id}-weekday`} label="Weekday" error={err("weekday")}>
            <Select
              id={`${id}-weekday`}
              options={WEEKDAY_OPTIONS}
              value={String(value.weekday)}
              invalid={!!err("weekday")}
              aria-describedby={fieldDescribedBy(`${id}-weekday`, { error: err("weekday") })}
              onChange={(e) => set({ weekday: Number(e.target.value) })}
            />
          </Field>
        ) : null}
        <Field id={`${id}-time`} label="Time" hint="24-hour clock, in the time zone below." error={err("time")}>
          <Input
            id={`${id}-time`}
            type="time"
            required
            value={value.time}
            invalid={!!err("time")}
            aria-describedby={fieldDescribedBy(`${id}-time`, { hint: true, error: err("time") })}
            onChange={(e) => set({ time: e.target.value })}
          />
        </Field>
        <Field id={`${id}-zone`} label="Time zone" error={err("timeZone")}>
          <Select
            id={`${id}-zone`}
            value={value.timeZone}
            invalid={!!err("timeZone")}
            aria-describedby={fieldDescribedBy(`${id}-zone`, { error: err("timeZone") })}
            onChange={(e) => set({ timeZone: e.target.value })}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-max`} label="Maximum stories" hint="1 to 50." error={err("maxStories")}>
          <Input
            id={`${id}-max`}
            inputMode="numeric"
            value={value.maxStories}
            invalid={!!err("maxStories")}
            aria-describedby={fieldDescribedBy(`${id}-max`, { hint: true, error: err("maxStories") })}
            onChange={(e) => set({ maxStories: e.target.value })}
            className="max-w-32"
          />
        </Field>
      </div>
    </div>
  );
}

export interface QuietHoursFieldsProps {
  id: string;
  value: QuietHours;
  onChange: (next: QuietHours) => void;
  /** The time zone of the digest settings (the quiet hours use it). */
  timeZone: string;
  errors?: Errors;
  errorPrefix?: string;
}

/** Quiet hours: on / off, start, end. */
export function QuietHoursFields({ id, value, onChange, timeZone, errors, errorPrefix = "quietHours" }: QuietHoursFieldsProps) {
  const set = (patch: Partial<QuietHours>) => onChange({ ...value, ...patch });
  const err = (key: string) => errorFor(errors, `${errorPrefix}.${key}`);
  return (
    <div className="flex flex-col gap-4">
      <Switch
        id={`${id}-on`}
        label="Quiet hours"
        description="During quiet hours a new alert waits until the period ends."
        showState
        checked={value.enabled}
        onChange={(e) => set({ enabled: e.target.checked })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-start`} label="Start" error={err("start")}>
          <Input
            id={`${id}-start`}
            type="time"
            required
            value={value.start}
            invalid={!!err("start")}
            aria-describedby={fieldDescribedBy(`${id}-start`, { error: err("start") })}
            onChange={(e) => set({ start: e.target.value })}
          />
        </Field>
        <Field id={`${id}-end`} label="End" error={err("end")}>
          <Input
            id={`${id}-end`}
            type="time"
            required
            value={value.end}
            invalid={!!err("end")}
            aria-describedby={fieldDescribedBy(`${id}-end`, { error: err("end") })}
            onChange={(e) => set({ end: e.target.value })}
          />
        </Field>
      </div>
      <p className="text-sm text-muted">
        Times are in the time zone of the digest ({timeZone.replaceAll("_", " ")}). The period can cross midnight. A start
        that is the same as the end counts as off.
      </p>
    </div>
  );
}

export interface AlertFieldsProps {
  id: string;
  value: AlertDraft;
  onChange: (next: AlertDraft) => void;
  errors?: Errors;
  errorPrefix?: string;
}

/** Alerts: on / off, the rule text, the minimum relevance. */
export function AlertFields({ id, value, onChange, errors, errorPrefix = "alerts" }: AlertFieldsProps) {
  const set = (patch: Partial<AlertDraft>) => onChange({ ...value, ...patch });
  const err = (key: string) => errorFor(errors, `${errorPrefix}.${key}`);
  return (
    <div className="flex flex-col gap-4">
      <Switch
        id={`${id}-on`}
        label="Alerts"
        description="An alert marks a story that deserves attention now: a dot on the feed tab and a banner on the feed page."
        showState
        checked={value.enabled}
        onChange={(e) => set({ enabled: e.target.checked })}
      />
      <Field
        id={`${id}-rule`}
        label="Which developments deserve an immediate alert?"
        hint="The model reads this rule for each new story. At most 300 characters."
        error={err("rule")}
      >
        <Textarea
          id={`${id}-rule`}
          rows={3}
          maxLength={300}
          value={value.rule}
          placeholder="For example: a security problem or a breaking change in a tool that this feed follows."
          invalid={!!err("rule")}
          aria-describedby={fieldDescribedBy(`${id}-rule`, { hint: true, error: err("rule") })}
          onChange={(e) => set({ rule: e.target.value })}
        />
      </Field>
      <Field id={`${id}-min`} label="Minimum relevance for an alert" hint="0 to 100. Default 85." error={err("minRelevance")}>
        <Input
          id={`${id}-min`}
          inputMode="numeric"
          value={value.minRelevance}
          invalid={!!err("minRelevance")}
          aria-describedby={fieldDescribedBy(`${id}-min`, { hint: true, error: err("minRelevance") })}
          onChange={(e) => set({ minRelevance: e.target.value })}
          className="max-w-32"
        />
      </Field>
    </div>
  );
}
