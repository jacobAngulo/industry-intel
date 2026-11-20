import type { ReactNode } from "react";

import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Banner, Icon, RelativeTime, cn } from "@/components/ui";
import type { AnalysisView, AppBanner } from "@/lib/services/types";
import { EFFORTS, EFFORT_LABELS, CONFIDENCES, type AnalysisAction, type AnalysisContent, type Effort } from "@/lib/types";

import { AnalysisRequestButton } from "./AnalysisRequestButton";
import { ANALYSIS_STEPS, CONFIDENCE_LABELS, analysisStepIndex, hostOf, safeHttpUrl, stringList } from "./format";
import { ModelText } from "./ModelText";

/** The banners that explain why an analysis waits (§13). */
export const MODEL_BANNER_KINDS: ReadonlyArray<AppBanner["kind"]> = ["no_model_key", "model_paused", "budget_used"];

function Paragraphs({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return empty ? <p className="text-muted">{empty}</p> : null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((text, i) => (
        <p key={i} className="text-pretty break-words">
          <ModelText text={text} />
        </p>
      ))}
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function actionsOf(value: unknown): AnalysisAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const a = entry as Record<string, unknown>;
    if (typeof a.action !== "string" || !a.action.trim()) return [];
    const effort: Effort = (EFFORTS as readonly unknown[]).includes(a.effort) ? (a.effort as Effort) : "quick_check";
    return [
      {
        action: a.action,
        why: typeof a.why === "string" ? a.why : "",
        effort,
        firstStep: typeof a.firstStep === "string" ? a.firstStep : "",
      },
    ];
  });
}

/** The done analysis (§4.2), from stored model output that is checked again here. */
function AnalysisBody({ content }: { content: AnalysisContent }) {
  const actions = actionsOf(content.suggestedActions);
  const openQuestions = stringList(content.openQuestions);
  const sources = stringList(content.sourcesUsed)
    .map((url) => safeHttpUrl(url))
    .filter((url): url is string => url !== null);
  const confidence = (CONFIDENCES as readonly unknown[]).includes(content.confidence) ? content.confidence : null;
  return (
    <div className="flex flex-col gap-6 leading-relaxed">
      <Part title="What changed, in detail">
        <Paragraphs items={stringList(content.whatChanged)} empty="The sources do not say more." />
      </Part>
      <Part title="How it works">
        <Paragraphs items={stringList(content.howItWorks)} empty="The sources do not say how it works." />
      </Part>
      <Part title="Implications">
        <Paragraphs items={stringList(content.whatItMeansForUs)} empty="The analysis found no specific implication for this feed." />
      </Part>
      <Part title="Risks and limits">
        <Paragraphs items={stringList(content.risksAndLimits)} empty="The sources name no risk or limit." />
      </Part>
      {actions.length > 0 ? (
        <Part title="Suggested actions">
          <ol className="flex flex-col gap-4">
            {actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-1 border-l-2 border-accent/40 pl-3">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                  <span>
                    <ModelText text={a.action} />
                  </span>
                  <Badge tone="accent">{EFFORT_LABELS[a.effort]}</Badge>
                </p>
                {a.why ? (
                  <p className="text-sm">
                    <span className="text-muted">Why: </span>
                    <ModelText text={a.why} />
                  </p>
                ) : null}
                {a.firstStep ? (
                  <p className="text-sm">
                    <span className="text-muted">First step: </span>
                    <ModelText text={a.firstStep} />
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </Part>
      ) : null}
      {openQuestions.length > 0 ? (
        <Part title="Open questions">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {openQuestions.map((q, i) => (
              <li key={i}>
                <ModelText text={q} />
              </li>
            ))}
          </ul>
        </Part>
      ) : null}
      <Part title="Confidence">
        <p>
          {confidence ? <span className="font-medium">{CONFIDENCE_LABELS[confidence]}. </span> : null}
          {typeof content.confidenceNote === "string" ? <ModelText text={content.confidenceNote} /> : null}
        </p>
      </Part>
      <Part title="Sources used">
        {sources.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {sources.map((url) => (
              <li key={url} className="min-w-0">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex max-w-full items-center gap-1.5 text-accent"
                >
                  <span className="truncate">
                    {hostOf(url)}
                    {new URL(url).pathname !== "/" ? new URL(url).pathname : ""}
                  </span>
                  <Icon name="external" size={14} />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">The analysis names no source link.</p>
        )}
      </Part>
    </div>
  );
}

function ProgressLine({ status, stage, waitReasons }: { status: "queued" | "running"; stage: string | null; waitReasons: string[] }) {
  const current = analysisStepIndex(status, stage);
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Progress of the analysis" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {ANALYSIS_STEPS.map((step, i) => (
          <li key={step} aria-current={i === current ? "step" : undefined} className="flex items-center gap-2">
            {i > 0 ? <Icon name="arrowRight" size={14} className="text-border-strong" /> : null}
            <span
              className={cn(
                "inline-flex items-center gap-1.5",
                i === current ? "font-medium text-fg" : i < current ? "text-muted" : "text-muted/70",
              )}
            >
              {i === current ? <Icon name="spinner" size={14} className="animate-spin text-accent motion-reduce:animate-none" /> : null}
              {i < current ? <Icon name="check" size={14} className="text-success" /> : null}
              {step}
            </span>
          </li>
        ))}
      </ol>
      <p role="status" className="sr-only">
        Analysis: {ANALYSIS_STEPS[current]}.
      </p>
      {waitReasons.map((text) => (
        <p key={text} className="flex items-start gap-1.5 text-sm text-warning">
          <Icon name="warning" size={14} className="mt-[3px]" />
          <span>{text}</span>
        </p>
      ))}
    </div>
  );
}

export interface AnalysisSectionProps {
  analysis: AnalysisView | null;
  feedSlug: string;
  storyId: number;
  now: number;
  /** The banners of getBanners(feedId): the model banners explain a wait. */
  banners: AppBanner[];
  /** The display name (for the name gate). */
  name: string | null;
}

/** The analysis section of the story page (§4.2) in each state: none, queued / running, done, failed. */
export function AnalysisSection({ analysis, feedSlug, storyId, now, banners, name }: AnalysisSectionProps) {
  const waitReasons = banners.filter((b) => MODEL_BANNER_KINDS.includes(b.kind)).map((b) => b.message);
  const button = (label: string, variant: "primary" | "secondary" = "primary") => (
    <AnalysisRequestButton feedSlug={feedSlug} storyId={storyId} name={name} label={label} variant={variant} />
  );

  let body: ReactNode;
  if (!analysis) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted">
          The model reads the sources again and writes a deeper technical analysis for this feed, with suggested actions.
          It takes about a minute.
        </p>
        {waitReasons.length > 0 ? <p className="text-sm text-warning">{waitReasons[0]}</p> : null}
        {button("Write the deeper analysis")}
      </div>
    );
  } else if (analysis.status === "queued" || analysis.status === "running") {
    body = (
      <div className="flex flex-col gap-6">
        <AutoRefresh everyMs={2000} active />
        <ProgressLine status={analysis.status} stage={analysis.stage} waitReasons={waitReasons} />
        {analysis.content ? (
          <div className="flex flex-col gap-4 opacity-80">
            <p className="text-sm text-muted">The analysis below is the earlier version.</p>
            <AnalysisBody content={analysis.content} />
          </div>
        ) : null}
      </div>
    );
  } else if (analysis.status === "failed") {
    body = (
      <Banner tone="alert" title="The analysis failed" actions={button("Try again", "secondary")}>
        {analysis.error ?? "The model did not write the analysis."}
      </Banner>
    );
  } else if (analysis.content) {
    body = (
      <div className="flex flex-col gap-6">
        <AnalysisBody content={analysis.content} />
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            Written by {analysis.model ?? "the model"}
            {analysis.finishedAt ? (
              <>
                {" "}
                <RelativeTime at={analysis.finishedAt} now={now} />
              </>
            ) : null}
            , asked by {analysis.requestedBy}.
          </p>
          {button("Write again", "secondary")}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted">The analysis has no content. Write it again.</p>
        {button("Write again")}
      </div>
    );
  }

  return (
    <section id="analysis" aria-labelledby="analysis-title" className="scroll-mt-6 flex flex-col gap-4">
      <h2 id="analysis-title" className="font-serif text-xl font-semibold text-fg">
        Deeper analysis
      </h2>
      {body}
    </section>
  );
}
