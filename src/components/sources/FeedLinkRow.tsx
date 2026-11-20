"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { rejudgeSourceAction, setFeedLinkAction } from "@/app/sources/actions";
import { Banner, Button, Field, Input, SavedNote, Select, Switch, fieldDescribedBy } from "@/components/ui";
import { PRIORITIES, PRIORITY_LABELS, type Priority } from "@/lib/types";

import { plural } from "./labels";
import { useGatedAction } from "./use-gated-action";

export const FOLLOW_IGNORE_HELP =
  "Follow: this feed takes only these subjects from this source. Ignore: this feed never takes these.";

export interface FeedLinkRowProps {
  sourceId: number;
  feed: { feedId: number; slug: string; name: string; included: boolean; priority: Priority; follow: string; ignore: string };
  name: string | null;
}

type Outcome =
  | { kind: "saved"; text: string; rejudgeEstimate: number | null }
  | { kind: "rejudged"; text: string };

/** One feed of the source page (§4.6 "Feeds"): the switch, priority, Follow, Ignore, and Save. */
export function FeedLinkRow({ sourceId, feed, name }: FeedLinkRowProps) {
  const id = useId();
  const router = useRouter();
  const [included, setIncluded] = useState(feed.included);
  const [priority, setPriority] = useState<Priority>(feed.priority);
  const [follow, setFollow] = useState(feed.follow);
  const [ignore, setIgnore] = useState(feed.ignore);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const save = useGatedAction(name);
  const rejudge = useGatedAction(name);

  const dirty =
    included !== feed.included ||
    (included && (priority !== feed.priority || follow.trim() !== feed.follow || ignore.trim() !== feed.ignore));

  const submit = () => {
    setError(null);
    setErrors({});
    setOutcome(null);
    save.run(
      () => setFeedLinkAction({ sourceId, feedId: feed.feedId, included, priority, follow, ignore }),
      (result) => {
        if (!result.ok) {
          setErrors(result.fieldErrors ?? {});
          setError(result.message);
          return;
        }
        const data = result.data;
        setSavedAt(Date.now());
        let text = "Saved.";
        if (data.included && !data.wasIncluded) {
          text =
            data.queuedStories > 0
              ? `${plural(data.queuedStories, "recent story is", "recent stories are")} queued for this feed.`
              : "The source is in this feed now. No recent story was waiting, so new items enter as they arrive.";
        } else if (!data.included && data.wasIncluded) {
          text = "The source left this feed. Its stories leave the feed unless another source of the feed has them.";
        }
        setOutcome({ kind: "saved", text, rejudgeEstimate: data.rejudgeEstimate });
        router.refresh();
      },
    );
  };

  const startRejudge = () => {
    setError(null);
    rejudge.run(
      () => rejudgeSourceAction({ sourceId, feedId: feed.feedId }),
      (result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        const p = result.data;
        setOutcome({
          kind: "rejudged",
          text: `The re-judge is queued: ${plural(p.total, "story", "stories")}. The feed settings show the progress.`,
        });
      },
    );
  };

  const describe = (fieldId: string, fieldError: string | undefined) =>
    [`${id}-help`, fieldDescribedBy(fieldId, { error: fieldError })].filter(Boolean).join(" ");

  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="font-medium">
          <Link href={`/f/${feed.slug}`} className="text-fg underline-offset-2 hover:underline">
            {feed.name}
          </Link>
        </h3>
        <Switch
          id={`${id}-included`}
          label="In this feed"
          showState
          checked={included}
          onChange={(e) => setIncluded(e.target.checked)}
        />
      </div>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {included ? (
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr]">
            <Field id={`${id}-priority`} label="Priority" error={errors.priority ?? null}>
              <Select
                id={`${id}-priority`}
                value={priority}
                options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
                onChange={(e) => setPriority(e.target.value as Priority)}
              />
            </Field>
            <Field id={`${id}-follow`} label="Follow" optional error={errors.follow ?? null}>
              <Input
                id={`${id}-follow`}
                value={follow}
                maxLength={300}
                placeholder="agents, permissions"
                invalid={!!errors.follow}
                aria-describedby={describe(`${id}-follow`, errors.follow)}
                onChange={(e) => setFollow(e.target.value)}
              />
            </Field>
            <Field id={`${id}-ignore`} label="Ignore" optional error={errors.ignore ?? null}>
              <Input
                id={`${id}-ignore`}
                value={ignore}
                maxLength={300}
                placeholder="cosmetic edits"
                invalid={!!errors.ignore}
                aria-describedby={describe(`${id}-ignore`, errors.ignore)}
                onChange={(e) => setIgnore(e.target.value)}
              />
            </Field>
            <p id={`${id}-help`} className="text-sm text-muted sm:col-span-3">
              {FOLLOW_IGNORE_HELP}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" variant={dirty ? "primary" : "secondary"} pending={save.pending} pendingLabel="Saving">
            Save<span className="sr-only"> for {feed.name}</span>
          </Button>
          <SavedNote at={savedAt} />
        </div>
      </form>
      <div role="status" aria-live="polite" className="flex flex-col gap-2">
        {outcome ? (
          <Banner
            tone="info"
            actions={
              outcome.kind === "saved" && outcome.rejudgeEstimate !== null && outcome.rejudgeEstimate > 0 ? (
                <Button size="sm" pending={rejudge.pending} pendingLabel="Queuing" onClick={startRejudge}>
                  Re-judge
                </Button>
              ) : null
            }
          >
            <p>{outcome.text}</p>
            {outcome.kind === "saved" && outcome.rejudgeEstimate !== null ? (
              <p className="mt-1">
                {outcome.rejudgeEstimate > 0
                  ? `The new Follow and Ignore apply to new items. Re-judge the stories of this source from the last 7 days in this feed? (about ${plural(outcome.rejudgeEstimate, "model call", "model calls")})`
                  : "The new Follow and Ignore apply to new items. This source has no story from the last 7 days to re-judge in this feed."}
              </p>
            ) : null}
          </Banner>
        ) : null}
      </div>
      {error ? (
        <div role="alert">
          <Banner tone="alert">{error}</Banner>
        </div>
      ) : null}
      {save.dialog}
      {rejudge.dialog}
    </section>
  );
}
