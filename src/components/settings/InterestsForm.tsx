"use client";

import { useState, type ReactNode } from "react";

import { saveFeedInterestsAction } from "@/app/f/[slug]/settings/actions";
import { addTopicAction } from "@/app/settings/actions";
import { Field, Input, SegmentedControl, Select, Textarea, fieldDescribedBy } from "@/components/ui";
import {
  RELEVANCE_PRIORITY_LABELS,
  RELEVANCE_WEIGHTS,
  RELEVANCE_WEIGHT_LABELS,
  TOPIC_PRIORITIES,
  TOPIC_PRIORITY_LABELS,
  type RelevancePriorities,
  type RelevanceWeight,
  type TopicPriority,
} from "@/lib/types";

import { changedTopicPriorities, errorFor, parseWholeNumber, samePhrases, textChanged, type RejudgeEstimate } from "./helpers";
import { PhraseListEditor } from "./PhraseListEditor";
import { RejudgeOffer } from "./RejudgeOffer";
import { SaveRow, SettingsSection } from "./SettingsSection";
import { useSave, type SaveHandle } from "./use-save";

const TOPIC_PRIORITY_OPTIONS = TOPIC_PRIORITIES.map((value) => ({ value, label: TOPIC_PRIORITY_LABELS[value] }));
const WEIGHT_OPTIONS = RELEVANCE_WEIGHTS.map((value) => ({ value, label: RELEVANCE_WEIGHT_LABELS[value] }));
const WEIGHT_KEYS = ["practical", "experiment"] as const;
const VALIDATION_MESSAGE = "Some fields are not valid. Correct the marked fields and try again.";

export interface InterestsTopic {
  id: number;
  name: string;
  description: string;
}

interface Interests {
  topicPriorities: Record<string, TopicPriority>;
  exclusions: string[];
  relevancePriorities: RelevancePriorities;
  minRelevance: number;
  halfLifeHours: number;
}

export interface InterestsFormProps {
  feedId: number;
  topics: InterestsTopic[];
  initial: Interests;
}

type Section = "topics" | "exclusions" | "priorities" | "minRelevance" | "halfLife";

/**
 * The Interests group (§4.8). Each section has its own Save. A save sends only
 * the keys of its section (a FeedInterestsPatch); the Topics section sends
 * only the topics whose priority changed. So a save never reverts a change
 * that another person saved in another section.
 */
export function InterestsForm({ feedId, topics, initial }: InterestsFormProps) {
  const [saved, setSaved] = useState<Interests>(initial);
  const [topicDraft, setTopicDraft] = useState<Record<string, TopicPriority>>(initial.topicPriorities);
  const [exclusions, setExclusions] = useState<string[]>(initial.exclusions);
  const [priorities, setPriorities] = useState<RelevancePriorities>(initial.relevancePriorities);
  const [minRelevance, setMinRelevance] = useState(String(initial.minRelevance));
  const [halfLife, setHalfLife] = useState(String(initial.halfLifeHours));
  const [offer, setOffer] = useState<{ section: Section | "addTopic"; estimates: RejudgeEstimate[] } | null>(null);

  const saves: Record<Section, SaveHandle<unknown, RejudgeEstimate[]>> = {
    topics: useSave(saveFeedInterestsAction),
    exclusions: useSave(saveFeedInterestsAction),
    priorities: useSave(saveFeedInterestsAction),
    minRelevance: useSave(saveFeedInterestsAction),
    halfLife: useSave(saveFeedInterestsAction),
  };

  /** Sends only `patch`; after the save, the patch becomes part of the values that this form saw. */
  const submit = (section: Section, patch: Partial<Interests>, judgeTimeChange: boolean) => {
    setOffer(null);
    void saves[section].run({ feedId, ...patch }, (estimates) => {
      setSaved((s) => ({
        ...s,
        ...patch,
        topicPriorities: { ...s.topicPriorities, ...(patch.topicPriorities ?? {}) },
      }));
      if (judgeTimeChange) setOffer({ section, estimates });
    });
  };

  const offerFor = (section: Section | "addTopic"): ReactNode =>
    offer && offer.section === section ? (
      <RejudgeOffer estimates={offer.estimates} onDismiss={() => setOffer(null)} />
    ) : null;

  const numberSection = (section: "minRelevance" | "halfLife", raw: string, min: number, max: number, key: keyof Interests) => {
    const parsed = parseWholeNumber(raw, min, max);
    if ("error" in parsed) {
      saves[section].setFailure({ message: VALIDATION_MESSAGE, fieldErrors: { [key]: parsed.error } });
      return;
    }
    submit(section, { [key]: parsed.value }, false);
  };

  const topicErrors = saves.topics.failure?.fieldErrors;
  const prioErrors = saves.priorities.failure?.fieldErrors;
  const minError = errorFor(saves.minRelevance.failure?.fieldErrors, "minRelevance");
  const halfError = errorFor(saves.halfLife.failure?.fieldErrors, "halfLifeHours");

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        id="topics"
        as="h2"
        title="Topics"
        description="High raises the stories of a topic, Low lowers them, and Muted hides them in this feed. The change applies at once."
      >
        {topics.length === 0 ? (
          <p className="text-sm text-muted">No topic yet. Add the first one below.</p>
        ) : (
          <form
            id={saves.topics.formId}
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const changed = changedTopicPriorities<TopicPriority>(
                saved.topicPriorities,
                topicDraft,
                topics.map((t) => t.id),
                "normal",
              );
              submit("topics", { topicPriorities: changed }, false);
            }}
          >
            <ul className="divide-y divide-border border-y border-border">
              {topics.map((topic) => {
                const fieldId = `topic-${topic.id}`;
                const error = errorFor(topicErrors, `topicPriorities.${topic.id}`);
                return (
                  <li key={topic.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <label htmlFor={fieldId} className="font-medium text-fg">
                        {topic.name}
                      </label>
                      {topic.description ? <p className="text-sm text-muted">{topic.description}</p> : null}
                      {error ? (
                        <p id={`${fieldId}-error`} className="text-sm text-alert">
                          {error}
                        </p>
                      ) : null}
                    </div>
                    <div className="w-full shrink-0 sm:w-36">
                      <Select
                        id={fieldId}
                        options={TOPIC_PRIORITY_OPTIONS}
                        value={topicDraft[String(topic.id)] ?? "normal"}
                        invalid={!!error}
                        aria-describedby={error ? `${fieldId}-error` : undefined}
                        onChange={(e) =>
                          setTopicDraft((d) => ({ ...d, [String(topic.id)]: e.target.value as TopicPriority }))
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <SaveRow
              pending={saves.topics.pending}
              savedAt={saves.topics.savedAt}
              error={saves.topics.failure?.message}
              label="Save topic priorities"
            />
          </form>
        )}
        <AddTopicForm feedId={feedId} onAdded={(estimates) => setOffer({ section: "addTopic", estimates })} />
        {offerFor("addTopic")}
      </SettingsSection>

      <SettingsSection
        id="exclusions"
        as="h2"
        title="Exclusions"
        description="Subjects that this feed never wants, for example “Funding announcements”. The model reads them for each new story."
      >
        <form
          id={saves.exclusions.formId}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit("exclusions", { exclusions }, !samePhrases(saved.exclusions, exclusions));
          }}
        >
          <PhraseListEditor
            id="exclusions"
            listLabel="Exclusions"
            addLabel="Add an exclusion"
            placeholder="A short phrase"
            emptyText="No exclusion. The feed takes every subject."
            value={exclusions}
            onChange={setExclusions}
            error={errorFor(saves.exclusions.failure?.fieldErrors, "exclusions")}
          />
          <SaveRow
            pending={saves.exclusions.pending}
            savedAt={saves.exclusions.savedAt}
            error={saves.exclusions.failure?.message}
            label="Save exclusions"
          />
        </form>
        {offerFor("exclusions")}
      </SettingsSection>

      <SettingsSection
        id="priorities"
        as="h2"
        title="Relevance priorities"
        description="What this feed favors. Off, Normal, and Strong change the order at once."
      >
        <form
          id={saves.priorities.formId}
          noValidate
          className="flex max-w-3xl flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit(
              "priorities",
              { relevancePriorities: priorities },
              textChanged(saved.relevancePriorities.other, priorities.other),
            );
          }}
        >
          {WEIGHT_KEYS.map((key) => (
            <SegmentedControl<RelevanceWeight>
              key={key}
              label={RELEVANCE_PRIORITY_LABELS[key]}
              name={`weight-${key}`}
              options={WEIGHT_OPTIONS}
              value={priorities[key]}
              onChange={(value) => setPriorities((p) => ({ ...p, [key]: value }))}
              className="justify-between"
            />
          ))}
          <Field
            id="other-priorities"
            label="Other priorities"
            hint="Free text that the model reads for each new story, for example “Favor changes to CI tools”."
            error={errorFor(prioErrors, "relevancePriorities.other")}
          >
            <Textarea
              id="other-priorities"
              rows={3}
              maxLength={4000}
              value={priorities.other}
              invalid={!!errorFor(prioErrors, "relevancePriorities.other")}
              aria-describedby={fieldDescribedBy("other-priorities", {
                hint: true,
                error: errorFor(prioErrors, "relevancePriorities.other"),
              })}
              onChange={(e) => setPriorities((p) => ({ ...p, other: e.target.value }))}
            />
          </Field>
          <SaveRow
            pending={saves.priorities.pending}
            savedAt={saves.priorities.savedAt}
            error={saves.priorities.failure?.message}
            label="Save priorities"
          />
        </form>
        {offerFor("priorities")}
      </SettingsSection>

      <SettingsSection id="min-relevance" as="h2" title="Minimum relevance to show">
        <form
          id={saves.minRelevance.formId}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            numberSection("minRelevance", minRelevance, 0, 100, "minRelevance");
          }}
        >
          <Field
            id="min-relevance-input"
            label="Minimum relevance (0 to 100)"
            hint="Stories under this number go to the filtered list. The bands: 90–100 act now, 70–89 useful this week, 50–69 worth knowing, under 50 a weak link or none."
            error={minError}
          >
            <Input
              id="min-relevance-input"
              inputMode="numeric"
              value={minRelevance}
              invalid={!!minError}
              aria-describedby={fieldDescribedBy("min-relevance-input", { hint: true, error: minError })}
              onChange={(e) => setMinRelevance(e.target.value)}
              className="max-w-32"
            />
          </Field>
          <SaveRow
            pending={saves.minRelevance.pending}
            savedAt={saves.minRelevance.savedAt}
            error={saves.minRelevance.failure?.message}
          />
        </form>
      </SettingsSection>

      <SettingsSection id="freshness" as="h2" title="Freshness">
        <form
          id={saves.halfLife.formId}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            numberSection("halfLife", halfLife, 1, 720, "halfLifeHours");
          }}
        >
          <Field
            id="half-life-input"
            label="Half-life in hours (1 to 720)"
            hint="After this many hours a story keeps half of its rank score. The Today view uses this value, 7 days uses 3 times it, 30 days uses 10 times it."
            error={halfError}
          >
            <Input
              id="half-life-input"
              inputMode="numeric"
              value={halfLife}
              invalid={!!halfError}
              aria-describedby={fieldDescribedBy("half-life-input", { hint: true, error: halfError })}
              onChange={(e) => setHalfLife(e.target.value)}
              className="max-w-32"
            />
          </Field>
          <SaveRow pending={saves.halfLife.pending} savedAt={saves.halfLife.savedAt} error={saves.halfLife.failure?.message} />
        </form>
      </SettingsSection>
    </div>
  );
}

/** "Add topic": name and description. Topics are shared by all feeds. */
export function AddTopicForm({
  feedId,
  onAdded,
  idPrefix = "new-topic",
}: {
  /** The feed whose re-judge estimate comes back (omit on the shared settings: every active feed). */
  feedId?: number;
  onAdded: (estimates: RejudgeEstimate[]) => void;
  idPrefix?: string;
}) {
  const save = useSave(addTopicAction);
  const [topicName, setTopicName] = useState("");
  const [description, setDescription] = useState("");
  const nameError = errorFor(save.failure?.fieldErrors, "name");
  const descriptionError = errorFor(save.failure?.fieldErrors, "description");

  return (
    <form
      id={save.formId}
      noValidate
      className="mt-6 flex max-w-3xl flex-col gap-4"
      aria-labelledby={`${idPrefix}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        const input = { name: topicName, description, ...(feedId === undefined ? {} : { feedId }) };
        void save.run(input, (data) => {
          setTopicName("");
          setDescription("");
          onAdded(data.estimates);
        });
      }}
    >
      <div>
        <h3 id={`${idPrefix}-title`} className="text-sm font-semibold text-fg">
          Add topic
        </h3>
        <p className="text-sm text-muted">Topics are shared by all feeds. Each feed sets its own priority.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Field id={`${idPrefix}-name`} label="Name" error={nameError}>
          <Input
            id={`${idPrefix}-name`}
            required
            maxLength={120}
            value={topicName}
            invalid={!!nameError}
            aria-describedby={fieldDescribedBy(`${idPrefix}-name`, { error: nameError })}
            onChange={(e) => setTopicName(e.target.value)}
          />
        </Field>
        <Field id={`${idPrefix}-description`} label="Description" optional error={descriptionError}>
          <Input
            id={`${idPrefix}-description`}
            maxLength={300}
            value={description}
            placeholder="One line that tells the model what belongs here"
            invalid={!!descriptionError}
            aria-describedby={fieldDescribedBy(`${idPrefix}-description`, { error: descriptionError })}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <SaveRow
        pending={save.pending}
        savedAt={save.savedAt}
        error={save.failure?.message}
        label="Add topic"
        savedText="Added"
      />
    </form>
  );
}

