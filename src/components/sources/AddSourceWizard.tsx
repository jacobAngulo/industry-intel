"use client";

// The add-source flow (specification §4.7): four steps, the state in the
// client, one Server Action for each step. Nothing is stored before step 4.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import {
  createSourcesAction,
  previewEntriesAction,
  qualifyAction,
  resolveEntriesAction,
} from "@/app/sources/new/actions";
import {
  Banner,
  Button,
  ChipToggle,
  Field,
  FieldGroup,
  Input,
  Select,
  SourceTypeIcon,
  Textarea,
  fieldDescribedBy,
} from "@/components/ui";
import { costNote as xSearchCostNote } from "@/lib/connectors/x_search/cost";
import { costNote as xUserCostNote } from "@/lib/connectors/x_user/cost";
import type { WizardCommon } from "@/lib/services/types";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  SOURCE_TYPES,
  SOURCE_TYPE_DEFAULTS,
  SOURCE_TYPE_LABELS,
  type Priority,
  type SourceType,
} from "@/lib/types";

import { checkConfig, type ConfigObject } from "./config-fields";
import { FOLLOW_IGNORE_HELP } from "./FeedLinkRow";
import { setFlash } from "./FlashMessage";
import { formatInterval, intervalOptions, joinNames, plural } from "./labels";
import { SourceConfigForm } from "./SourceConfigForm";
import { useGatedAction } from "./use-gated-action";
import {
  MAX_ENTRIES,
  canReuseQualify,
  combinedSourceName,
  errorsAt,
  ownerForCreate,
  planEntries,
  splitEntries,
  type PreviewStep,
  type QualifyState,
  type ResolvedEntry,
  type WizardCandidate,
} from "./wizard-logic";
import { CandidateBody, ExistingNote, PreviewList, QualifyView, StepHeading, StepList } from "./wizard-parts";

export interface WizardFeed {
  id: number;
  slug: string;
  name: string;
}

export interface WizardSuggestion {
  feedSlug: string;
  type: SourceType;
  name: string;
  why: string;
  url?: string;
  config: unknown;
}

export interface AddSourceWizardProps {
  initialText: string;
  initialType: SourceType | null;
  feeds: WizardFeed[];
  preselectedFeedIds: number[];
  suggestions: WizardSuggestion[];
  identityFields: Record<SourceType, readonly string[]>;
  displayName: string | null;
}

interface Draft {
  input: string;
  candidate: WizardCandidate;
  name: string;
  config: ConfigObject;
}

interface CommonState {
  why: string;
  feedIds: number[];
  follow: string;
  ignore: string;
  priority: Priority;
  interval: number;
  owner: string;
}

const INVALID = "Some fields are not valid. Correct the marked fields and try again.";

function asConfig(value: unknown): ConfigObject {
  return value && typeof value === "object" ? { ...(value as ConfigObject) } : {};
}

function toCommon(common: CommonState): WizardCommon {
  return {
    why: common.why,
    feedIds: common.feedIds,
    follow: common.follow,
    ignore: common.ignore,
    priority: common.priority,
    checkIntervalMinutes: common.interval,
    owner: common.owner.trim() ? common.owner : null,
  };
}

export function AddSourceWizard({
  initialText,
  initialType,
  feeds,
  preselectedFeedIds,
  suggestions,
  identityFields,
  displayName,
}: AddSourceWizardProps) {
  const id = useId();
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const [step, setStep] = useState(1);
  // Step 1
  const [text, setText] = useState(initialText);
  const [forcedType, setForcedType] = useState<SourceType | null>(initialType);
  const [resolved, setResolved] = useState<ResolvedEntry[] | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [chosenType, setChosenType] = useState<SourceType | null>(null);
  const [resolving, startResolve] = useTransition();
  // Step 2
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [common, setCommon] = useState<CommonState>({
    why: "",
    feedIds: preselectedFeedIds,
    follow: "",
    ignore: "",
    priority: "normal",
    interval: 60,
    owner: displayName ?? "",
  });
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [stepError, setStepError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  // Step 3
  const [preview, setPreview] = useState<{ key: string; data: PreviewStep } | null>(null);
  const [qualify, setQualify] = useState<QualifyState | null>(null);
  const [qualifying, startQualify] = useTransition();
  // Step 4
  const create = useGatedAction(displayName);
  const [createError, setCreateError] = useState<string | null>(null);

  // The focus moves to the heading of the new step (not on the first render).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const type: SourceType | null = drafts[0]?.candidate.type ?? null;
  const entryCount = splitEntries(text, forcedType).length;

  // ---------------------------------------------------------------- step 1
  const findSources = () => {
    const entries = splitEntries(text, forcedType);
    setResolveError(null);
    if (entries.length === 0) {
      setResolveError("Paste a link, enter a sender, or describe a topic.");
      return;
    }
    if (entries.length > MAX_ENTRIES) {
      setResolveError(`Enter at most ${MAX_ENTRIES} entries at one time. This text has ${entries.length}.`);
      return;
    }
    startResolve(async () => {
      try {
        const result = await resolveEntriesAction({ entries, type: forcedType });
        if (!result.ok) {
          setResolved(null);
          setResolveError(result.message);
          return;
        }
        setResolved(result.data);
        const firstFree = result.data[0]?.candidates.findIndex((c) => !c.existing) ?? -1;
        setSelected(firstFree >= 0 ? firstFree : 0);
        setChosenType(null);
      } catch {
        setResolveError("The search did not reach the server. Check the connection and try again.");
      }
    });
  };

  const startStep2 = (next: Draft[], opts: { why?: string; feedSlug?: string } = {}) => {
    const t = next[0]!.candidate.type;
    setDrafts(next);
    setCommon((c) => {
      const feedId = opts.feedSlug ? feeds.find((f) => f.slug === opts.feedSlug)?.id : undefined;
      return {
        ...c,
        why: opts.why ?? c.why,
        feedIds: feedId !== undefined && !c.feedIds.includes(feedId) ? [...c.feedIds, feedId] : c.feedIds,
        interval: SOURCE_TYPE_DEFAULTS[t].intervalMinutes,
      };
    });
    setFieldErrors({});
    setStepError(null);
    setPreview(null);
    setQualify(null);
    setStep(2);
  };

  const draftOf = (input: string, candidate: WizardCandidate): Draft => ({
    input,
    candidate,
    name: candidate.name.slice(0, 120),
    config: asConfig(candidate.config),
  });

  const applySuggestion = (s: WizardSuggestion) => {
    const candidate: WizardCandidate = {
      type: s.type,
      name: s.name,
      description: s.why,
      config: s.config,
      confidence: 1,
      existing: null,
      ...(s.url ? { url: s.url } : {}),
    };
    startStep2([draftOf(s.name, candidate)], { why: s.why, feedSlug: s.feedSlug });
  };

  // ---------------------------------------------------------------- step 2
  const nonIdentity = (t: SourceType, config: ConfigObject): ConfigObject =>
    Object.fromEntries(Object.entries(config).filter(([key]) => !identityFields[t].includes(key) && key !== "variant"));

  /** The options form of several entries sets the non-identity fields of every entry of the same variant. */
  const setSharedOptions = (next: ConfigObject) => {
    setDrafts((list) => {
      const first = list[0];
      if (!first) return list;
      const t = first.candidate.type;
      const shared = nonIdentity(t, next);
      const removed = Object.keys(nonIdentity(t, first.config)).filter((key) => !(key in shared));
      return list.map((draft) => {
        if (draft.config.variant !== first.config.variant) return draft;
        const config = { ...draft.config, ...shared };
        for (const key of removed) delete config[key];
        return { ...draft, config };
      });
    });
  };

  const localStep2Errors = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    drafts.forEach((draft, index) => {
      if (!draft.name.trim()) errors[`entries.${index}.name`] = "Enter a name.";
      for (const [key, message] of Object.entries(checkConfig(draft.candidate.type, draft.config))) {
        errors[`entries.${index}.config.${key}`] = message;
      }
    });
    if (!common.why.trim()) errors["common.why"] = "Say why this source matters.";
    return errors;
  };

  const entriesForServer = (list: Draft[]) =>
    list.map((draft) => ({
      type: draft.candidate.type,
      name: draft.name,
      config: draft.config,
      ...(draft.candidate.url ? { url: draft.candidate.url } : {}),
    }));

  const runQualify = (list: Draft[], data: PreviewStep, c: CommonState) => {
    if (c.feedIds.length === 0 || list.length === 0) {
      setQualify(null);
      return;
    }
    const items = data.preview.entries.flatMap((entry) => entry.items);
    const key = JSON.stringify({ items: items.map((i) => i.externalId), feeds: c.feedIds, f: c.follow, i: c.ignore, p: c.priority });
    if (canReuseQualify(qualify, key)) return;
    setQualify({ key, result: null, error: null });
    startQualify(async () => {
      try {
        const result = await qualifyAction({
          type: list[0]!.candidate.type,
          sourceName: combinedSourceName(list.map((d) => d.name.trim())),
          items,
          config: list[0]!.config,
          feedIds: c.feedIds,
          follow: c.follow,
          ignore: c.ignore,
          priority: c.priority,
        });
        setQualify(result.ok ? { key, result: result.data, error: null } : { key, result: null, error: result.message });
      } catch {
        setQualify({ key, result: null, error: "The model check did not reach the server." });
      }
    });
  };

  const toPreview = () => {
    const local = localStep2Errors();
    setFieldErrors(local);
    if (Object.keys(local).length > 0) {
      setStepError(INVALID);
      return;
    }
    setStepError(null);
    const entries = entriesForServer(drafts);
    const key = JSON.stringify(entries.map((e) => ({ type: e.type, config: e.config })));
    if (preview && preview.key === key) {
      setStep(3);
      runQualify(drafts, preview.data, common);
      return;
    }
    startPreview(async () => {
      try {
        const result = await previewEntriesAction({ entries, common: toCommon(common) });
        if (!result.ok) {
          setFieldErrors(result.fieldErrors ?? {});
          setStepError(result.message);
          return;
        }
        const next = drafts.map((draft, index) => ({ ...draft, config: asConfig(result.data.configs[index] ?? draft.config) }));
        const nextKey = JSON.stringify(next.map((d) => ({ type: d.candidate.type, config: d.config })));
        setDrafts(next);
        setPreview({ key: nextKey, data: result.data });
        setStep(3);
        runQualify(next, result.data, common);
      } catch {
        setStepError("The preview did not reach the server. Check the connection and try again.");
      }
    });
  };

  // ---------------------------------------------------------------- step 4
  const addSources = () => {
    setCreateError(null);
    create.run(
      (savedName) => {
        // The name gate can save the name just before this call: it is the owner when the field was not edited.
        const owner = ownerForCreate(common.owner, ownerTouched, savedName);
        if (owner !== common.owner) setCommon((c) => ({ ...c, owner }));
        return createSourcesAction({ entries: entriesForServer(drafts), common: toCommon({ ...common, owner }) });
      },
      (result) => {
        if (!result.ok) {
          setCreateError(result.message);
          if (result.fieldErrors) setFieldErrors(result.fieldErrors);
          return;
        }
        const { created, skipped, queuedStories } = result.data;
        if (created.length === 0) {
          setCreateError(
            `No source was added. ${skipped.map((s) => `${s.name}: ${s.reason}`).join(" ")}`.trim(),
          );
          return;
        }
        const lines = [
          "The worker runs the first check within a minute.",
          ...(queuedStories > 0 ? [`${plural(queuedStories, "recent story is", "recent stories are")} queued for the selected feeds.`] : []),
          ...skipped.map((s) => `Not added: ${s.name}. ${s.reason}`),
        ];
        setFlash({
          tone: skipped.length > 0 ? "warning" : "info",
          title: created.length === 1 ? `Added the source "${created[0]!.name}".` : `Added ${created.length} sources: ${joinNames(created.map((c) => c.name))}.`,
          lines,
        });
        router.push(created.length === 1 ? `/sources/${created[0]!.id}` : `/sources?type=${drafts[0]!.candidate.type}`);
      },
    );
  };

  // ---------------------------------------------------------------- render
  return (
    <div>
      <StepList step={step} />
      <StepHeading step={step} headingRef={headingRef} />
      {step === 1 ? renderStep1() : step === 2 ? renderStep2() : step === 3 ? renderStep3() : renderStep4()}
      {create.dialog}
    </div>
  );

  function renderStep1() {
    const single = resolved !== null && resolved.length === 1 ? resolved[0]! : null;
    const plan = resolved !== null && resolved.length > 1 ? planEntries(resolved, { forcedType, chosen: chosenType }) : null;
    const singlePick = single?.candidates[selected] ?? null;
    return (
      <div className="flex flex-col gap-8">
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            findSources();
          }}
        >
          <Field
            id={`${id}-entries`}
            label="Links, senders, or topics"
            hint={`Paste a link, enter a sender, or describe a topic. For several, use one line for each (at most ${MAX_ENTRIES}). X handles can also be separated with commas.`}
            error={resolveError}
          >
            <Textarea
              id={`${id}-entries`}
              rows={4}
              value={text}
              maxLength={20000}
              placeholder={"https://github.com/anthropics/claude-code\n@chamath\nagent evaluations"}
              invalid={!!resolveError}
              aria-describedby={fieldDescribedBy(`${id}-entries`, { hint: true, error: resolveError })}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  findSources();
                }
              }}
            />
          </Field>
          <FieldGroup legend="Type (optional)" hint="Choose a type when the app guesses wrong, or for a list of one type.">
            <div className="flex flex-wrap gap-2">
              <ChipToggle
                pressed={forcedType === null}
                onClick={() => {
                  setForcedType(null);
                  setResolved(null);
                }}
              >
                Any type
              </ChipToggle>
              {SOURCE_TYPES.map((t) => (
                <ChipToggle
                  key={t}
                  pressed={forcedType === t}
                  onClick={() => {
                    setForcedType(forcedType === t ? null : t);
                    setResolved(null);
                  }}
                >
                  <SourceTypeIcon type={t} size={14} />
                  {SOURCE_TYPE_LABELS[t]}
                </ChipToggle>
              ))}
            </div>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" icon="search" pending={resolving} pendingLabel="Searching">
              Find sources
            </Button>
            <span className="text-sm text-muted">{entryCount > 1 ? `${entryCount} entries` : null}</span>
          </div>
        </form>

        <div aria-live="polite" className="flex flex-col gap-4">
          {single ? renderSingle(single, singlePick) : null}
          {plan ? renderPlan(plan) : null}
        </div>

        {suggestions.length > 0 ? (
          <section aria-labelledby={`${id}-suggestions`} className="flex flex-col gap-3">
            <h3 id={`${id}-suggestions`} className="font-medium">
              Starter suggestions
            </h3>
            <p className="text-sm text-muted">Sources that teams like yours often follow and that are not in the directory yet.</p>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
              {suggestions.map((s) => (
                <li key={`${s.type}:${s.name}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <SourceTypeIcon type={s.type} size={16} className="text-muted" />
                      <span className="font-medium">{s.name}</span>
                      <span className="text-sm text-muted">{SOURCE_TYPE_LABELS[s.type]}</span>
                    </span>
                    <span className="text-sm text-muted">{s.why}</span>
                  </span>
                  <Button size="sm" onClick={() => applySuggestion(s)}>
                    Use this<span className="sr-only">: {s.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  function renderSingle(entry: ResolvedEntry, pick: WizardCandidate | null) {
    if (entry.candidates.length === 0) {
      return <Banner tone="warning" title={`Nothing found for "${entry.input}"`}>{entry.error ?? "Check the spelling, or paste a full link."}</Banner>;
    }
    return (
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium">
            {entry.candidates.length === 1 ? "The app found this source" : `Choose the source (${entry.candidates.length} matches)`}
          </legend>
          {entry.candidates.map((candidate, index) => (
            <label
              key={`${candidate.type}-${index}`}
              className="flex cursor-pointer items-start gap-3 rounded-card border border-border bg-surface p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name={`${id}-candidate`}
                checked={selected === index}
                onChange={() => setSelected(index)}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <CandidateBody candidate={candidate} />
            </label>
          ))}
        </fieldset>
        {pick?.existing ? <ExistingNote source={pick.existing} /> : null}
        <div>
          <Button
            variant="primary"
            iconEnd="arrowRight"
            disabled={!pick || !!pick.existing}
            onClick={() => pick && startStep2([draftOf(entry.input, pick)])}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  function renderPlan(plan: ReturnType<typeof planEntries>) {
    const unresolved =
      plan.unresolved.length > 0 ? (
        <Banner tone="warning" title={`Not found (${plan.unresolved.length})`}>
          <p>These entries did not match a source{forcedType ? ` of the type ${SOURCE_TYPE_LABELS[forcedType]}` : ""}. Check the spelling, or add them one at a time.</p>
          <ul className="mt-1 list-disc pl-5">
            {plan.unresolved.map((input) => (
              <li key={input} className="break-words">
                {input}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null;

    if (plan.kind === "no_common_type") {
      return (
        <>
          <Banner tone="warning" title="These entries do not share one type">
            Several entries become one source each, so they must all be of one type. Choose a type above and search again, or add the entries one at a time.
          </Banner>
          {unresolved}
        </>
      );
    }
    if (plan.kind === "choose_type") {
      return (
        <>
          <FieldGroup legend="These entries fit more than one type. Choose one:">
            <div className="flex flex-wrap gap-2">
              {plan.types.map((t) => (
                <ChipToggle key={t} pressed={false} onClick={() => setChosenType(t)}>
                  <SourceTypeIcon type={t} size={14} />
                  {SOURCE_TYPE_LABELS[t]}
                </ChipToggle>
              ))}
            </div>
          </FieldGroup>
          {unresolved}
        </>
      );
    }
    return (
      <>
        <section aria-labelledby={`${id}-picks`} className="flex flex-col gap-2">
          <h3 id={`${id}-picks`} className="font-medium">
            {plural(plan.picks.length, "new source", "new sources")} of the type {SOURCE_TYPE_LABELS[plan.type]}
          </h3>
          {plan.picks.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {plan.picks.map((pick) => (
                <li key={pick.input} className="rounded-card border border-border bg-surface p-3">
                  <CandidateBody candidate={pick.candidate} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Every entry is in the directory already.</p>
          )}
        </section>
        {plan.otherTypes.length > 0 ? (
          <FieldGroup legend="Use another type instead:">
            <div className="flex flex-wrap gap-2">
              {[plan.type, ...plan.otherTypes].map((t) => (
                <ChipToggle key={t} pressed={t === plan.type} onClick={() => setChosenType(t)}>
                  <SourceTypeIcon type={t} size={14} />
                  {SOURCE_TYPE_LABELS[t]}
                </ChipToggle>
              ))}
            </div>
          </FieldGroup>
        ) : null}
        {plan.existing.length > 0 ? (
          <div className="flex flex-col gap-2">
            {plan.existing.map((e) => (
              <ExistingNote key={e.input} source={e.source} />
            ))}
          </div>
        ) : null}
        {unresolved}
        <div>
          <Button
            variant="primary"
            iconEnd="arrowRight"
            disabled={plan.picks.length === 0}
            onClick={() => startStep2(plan.picks.map((p) => draftOf(p.input, p.candidate)))}
          >
            Continue with {plural(plan.picks.length, "source", "sources")}
          </Button>
        </div>
      </>
    );
  }

  function renderStep2() {
    if (!type) return null;
    const several = drafts.length > 1;
    const warnings = [...new Set(drafts.flatMap((d) => d.candidate.warnings ?? []))];
    const configErrors = (index: number) => errorsAt(fieldErrors, `entries.${index}.config`);
    const firstConfig = drafts[0]!.config;
    return (
      <form
        noValidate
        className="flex flex-col gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          toPreview();
        }}
      >
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <SourceTypeIcon type={type} size={16} />
          {SOURCE_TYPE_LABELS[type]} · {plural(drafts.length, "source", "sources")}
          {several ? " · all fields except the name apply to every source" : ""}
        </p>
        {warnings.map((w) => (
          <Banner key={w} tone="warning">
            {w}
          </Banner>
        ))}

        <section aria-labelledby={`${id}-options`} className="flex flex-col gap-4">
          <h3 id={`${id}-options`} className="font-medium">
            Options for this {SOURCE_TYPE_LABELS[type]}
          </h3>
          <SourceConfigForm
            type={type}
            value={firstConfig}
            mode="create"
            errors={several ? {} : configErrors(0)}
            hiddenFields={several ? identityFields[type] : []}
            onChange={(next) =>
              several ? setSharedOptions(next) : setDrafts((list) => list.map((d, i) => (i === 0 ? { ...d, config: next } : d)))
            }
          />
          {several
            ? drafts.map((d, index) => {
                const errors = Object.entries(configErrors(index));
                return errors.length > 0 ? (
                  <Banner key={d.input} tone="alert" title={`${d.name || d.input}: the settings are not valid`}>
                    <ul className="list-disc pl-5">
                      {errors.map(([key, message]) => (
                        <li key={key}>{message}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : null;
              })
            : null}
          {renderTypeNotes()}
        </section>

        <section aria-labelledby={`${id}-common`} className="flex flex-col gap-4">
          <h3 id={`${id}-common`} className="font-medium">
            Details
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {drafts.map((d, index) => {
              const fid = `${id}-name-${index}`;
              const error = fieldErrors[`entries.${index}.name`] ?? null;
              return (
                <Field key={d.input} id={fid} label={several ? `Name for "${d.input}"` : "Name"} error={error}>
                  <Input
                    id={fid}
                    value={d.name}
                    maxLength={120}
                    required
                    invalid={!!error}
                    aria-describedby={fieldDescribedBy(fid, { error })}
                    onChange={(e) => setDrafts((list) => list.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)))}
                  />
                </Field>
              );
            })}
            <Field
              id={`${id}-why`}
              label="Why it matters"
              hint="One short line, for example: release notes for a coding agent."
              error={fieldErrors["common.why"] ?? null}
              className="sm:col-span-2"
            >
              <Input
                id={`${id}-why`}
                value={common.why}
                maxLength={300}
                required
                invalid={!!fieldErrors["common.why"]}
                aria-describedby={fieldDescribedBy(`${id}-why`, { hint: true, error: fieldErrors["common.why"] })}
                onChange={(e) => setCommon((c) => ({ ...c, why: e.target.value }))}
              />
            </Field>
          </div>

          <FieldGroup
            legend="Feeds"
            hint="Zero or more. A source in no feed is still checked, but its items are not judged."
            error={fieldErrors["common.feedIds"] ?? null}
          >
            {feeds.length === 0 ? <p className="text-sm text-muted">There is no active feed yet.</p> : null}
            <div className="flex flex-col gap-1">
              {feeds.map((f) => (
                <label key={f.id} className="inline-flex min-h-10 cursor-pointer items-center gap-2 sm:min-h-8">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={common.feedIds.includes(f.id)}
                    onChange={(e) =>
                      setCommon((c) => ({
                        ...c,
                        feedIds: e.target.checked ? [...c.feedIds, f.id] : c.feedIds.filter((x) => x !== f.id),
                      }))
                    }
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </FieldGroup>

          {common.feedIds.length > 0 ? (
            <div className="grid gap-4 rounded-card border border-border bg-surface-2 p-4 sm:grid-cols-[10rem_1fr_1fr]">
              <p id={`${id}-fi-help`} className="text-sm text-muted sm:col-span-3">
                For the selected feeds. {FOLLOW_IGNORE_HELP}
              </p>
              <Field id={`${id}-priority`} label="Priority">
                <Select
                  id={`${id}-priority`}
                  value={common.priority}
                  options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
                  onChange={(e) => setCommon((c) => ({ ...c, priority: e.target.value as Priority }))}
                />
              </Field>
              <Field id={`${id}-follow`} label="Follow" optional error={fieldErrors["common.follow"] ?? null}>
                <Input
                  id={`${id}-follow`}
                  value={common.follow}
                  maxLength={300}
                  placeholder="agent workflows, enterprise deployment"
                  aria-describedby={`${id}-fi-help`}
                  onChange={(e) => setCommon((c) => ({ ...c, follow: e.target.value }))}
                />
              </Field>
              <Field id={`${id}-ignore`} label="Ignore" optional error={fieldErrors["common.ignore"] ?? null}>
                <Input
                  id={`${id}-ignore`}
                  value={common.ignore}
                  maxLength={300}
                  placeholder="event announcements"
                  aria-describedby={`${id}-fi-help`}
                  onChange={(e) => setCommon((c) => ({ ...c, ignore: e.target.value }))}
                />
              </Field>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${id}-interval`}
              label="Check interval"
              hint="How often the worker asks the source for new items."
              error={fieldErrors["common.checkIntervalMinutes"] ?? null}
            >
              <Select
                id={`${id}-interval`}
                value={String(common.interval)}
                options={intervalOptions(common.interval, SOURCE_TYPE_DEFAULTS[type].intervalMinutes)}
                aria-describedby={fieldDescribedBy(`${id}-interval`, { hint: true })}
                onChange={(e) => setCommon((c) => ({ ...c, interval: Number(e.target.value) }))}
              />
            </Field>
            <Field
              id={`${id}-owner`}
              label="Owner"
              optional
              hint="The person who keeps the settings of this source up to date. You can clear it."
              error={fieldErrors["common.owner"] ?? null}
            >
              <Input
                id={`${id}-owner`}
                value={common.owner}
                maxLength={120}
                aria-describedby={fieldDescribedBy(`${id}-owner`, { hint: true })}
                onChange={(e) => {
                  setOwnerTouched(true);
                  setCommon((c) => ({ ...c, owner: e.target.value }));
                }}
              />
            </Field>
          </div>
          {type === "x_user" || type === "x_search" ? (
            <Banner tone="info" title="Cost">
              {type === "x_user"
                ? xUserCostNote({ username: typeof firstConfig.username === "string" ? firstConfig.username : "" }, common.interval)
                : xSearchCostNote({ maxPostsPerRun: typeof firstConfig.maxPostsPerRun === "number" ? firstConfig.maxPostsPerRun : 20 }, common.interval)}
              {several ? ` This applies to each of the ${drafts.length} sources.` : ""}
            </Banner>
          ) : null}
        </section>

        {stepError ? (
          <div role="alert">
            <Banner tone="alert">{stepError}</Banner>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button variant="ghost" icon="undo" onClick={() => setStep(1)} disabled={previewing}>
            Back
          </Button>
          <Button type="submit" variant="primary" iconEnd="arrowRight" pending={previewing} pendingLabel="Loading the preview">
            Preview
          </Button>
        </div>
      </form>
    );
  }

  function renderTypeNotes() {
    if (!type) return null;
    const config = drafts[0]?.config ?? {};
    if (type === "docs") {
      return (
        <p className="text-sm text-muted">
          {config.mode === "page"
            ? "This page has no dated entries. New and changed sections become items."
            : config.mode === "changelog"
              ? "Each new dated entry of the changelog becomes an item."
              : "On the first check the app decides: a page with at least 3 dated entries is read as a changelog; else new and changed sections become items."}
        </p>
      );
    }
    if (type === "web_search") {
      return (
        <p className="text-sm text-muted">
          The first run stores the current results as a starting point and does not judge them. Later runs show only new results. Each run costs one web search.
        </p>
      );
    }
    return null;
  }

  function renderStep3() {
    if (!preview) return null;
    const currentQualify = qualify;
    return (
      <div className="flex flex-col gap-8">
        <PreviewList preview={preview.data.preview} />
        <QualifyView
          result={currentQualify?.result ?? null}
          pending={qualifying || (currentQualify !== null && !currentQualify.result && !currentQualify.error)}
          error={currentQualify?.error ?? null}
          noFeeds={common.feedIds.length === 0}
        />
        <div className="flex flex-wrap gap-3">
          <Button variant="ghost" icon="undo" onClick={() => setStep(2)}>
            Back to change the filters
          </Button>
          <Button variant="primary" iconEnd="arrowRight" onClick={() => setStep(4)}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  function renderStep4() {
    if (!type) return null;
    const feedNames = feeds.filter((f) => common.feedIds.includes(f.id)).map((f) => f.name);
    const rows: Array<[string, string]> = [
      [drafts.length === 1 ? "Source" : "Sources", joinNames(drafts.map((d) => d.name.trim()))],
      ["Type", SOURCE_TYPE_LABELS[type]],
      ["Why it matters", common.why.trim()],
      ["Feeds", feedNames.length > 0 ? joinNames(feedNames) : "No feed yet"],
      ...(feedNames.length > 0
        ? ([
            ["Priority", PRIORITY_LABELS[common.priority]],
            ["Follow", common.follow.trim() || "Everything"],
            ["Ignore", common.ignore.trim() || "Nothing"],
          ] as Array<[string, string]>)
        : []),
      ["Check interval", formatInterval(common.interval)],
      ["Owner", common.owner.trim() || "No owner"],
    ];
    return (
      <div className="flex flex-col gap-6">
        <dl className="grid gap-x-6 gap-y-2 rounded-card border border-border bg-surface p-4 text-sm sm:grid-cols-[10rem_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted">
          The app adds {drafts.length === 1 ? "the source" : `the ${drafts.length} sources`} to the shared directory, asks for the first check now
          {feedNames.length > 0 ? ", and queues the recent stories for the selected feeds" : ""}. Everybody who uses the app can see and change {drafts.length === 1 ? "it" : "them"}.
        </p>
        {createError ? (
          <div role="alert">
            <Banner tone="alert">{createError}</Banner>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button variant="ghost" icon="undo" onClick={() => setStep(3)} disabled={create.pending}>
            Back
          </Button>
          {createError && Object.keys(fieldErrors).length > 0 ? (
            <Button variant="secondary" onClick={() => setStep(2)}>
              Correct the fields
            </Button>
          ) : null}
          <Button variant="primary" icon="add" pending={create.pending} pendingLabel="Adding" onClick={addSources}>
            {drafts.length === 1 ? "Add source" : `Add ${drafts.length} sources`}
          </Button>
        </div>
      </div>
    );
  }
}
