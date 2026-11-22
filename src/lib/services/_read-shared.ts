// Private helpers of the read services (stories, feedback, analyses, digests,
// status). Pages do not import this file: index.ts does not re-export it.
import { getSqlite } from "@/lib/db/client";
import { effectiveBriefFormatOf } from "@/lib/ranking/recompute";
import {
  FEEDBACK_REASONS,
  WORK_STATUSES,
  type AlertSettings,
  type AnalysisContent,
  type BriefFormat,
  type FeedbackReason,
  type WorkStatus,
} from "@/lib/types";

import type { AnalysisView } from "./types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// One error class for the whole services layer: serviceFailure() in a Server
// Action recognizes it with instanceof, so a second class would show the error
// page instead of `{ ok: false }`.
export { ServiceError, type ServiceErrorCode } from "./_manage-errors";

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

export function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStringList(text: unknown): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function parseIdList(text: unknown): number[] {
  const value = parseJson(text);
  return Array.isArray(value) ? [...new Set(value.filter((id): id is number => Number.isInteger(id)))] : [];
}

export function asFeedbackReason(value: unknown): FeedbackReason | null {
  return typeof value === "string" && (FEEDBACK_REASONS as readonly string[]).includes(value)
    ? (value as FeedbackReason)
    : null;
}

// ---------------------------------------------------------------------------
// The feed facts that the reads need
// ---------------------------------------------------------------------------

export interface FeedFacts {
  id: number;
  slug: string;
  name: string;
  halfLifeHours: number;
  brief: BriefFormat;
  alerts: AlertSettings;
  timeZone: string;
}

const NO_ALERTS: AlertSettings = { enabled: false, rule: "", minRelevance: 85 };

function parseAlerts(text: unknown): AlertSettings {
  const value = parseJson(text);
  if (!isRecord(value)) return NO_ALERTS;
  return {
    enabled: value.enabled === true,
    rule: typeof value.rule === "string" ? value.rule : "",
    minRelevance: typeof value.minRelevance === "number" ? value.minRelevance : NO_ALERTS.minRelevance,
  };
}

function parseTimeZone(digestJson: unknown): string {
  const value = parseJson(digestJson);
  return isRecord(value) && typeof value.timeZone === "string" && value.timeZone ? value.timeZone : "UTC";
}

/** The feed (archived or not), or null when no feed has this id. */
export function loadFeedFacts(feedId: number): FeedFacts | null {
  const row = getSqlite()
    .prepare(
      `SELECT id, slug, name, half_life_hours AS halfLifeHours, brief_format AS briefFormat, alerts, digest
         FROM feeds WHERE id = ?`,
    )
    .get(feedId) as
    | { id: number; slug: string; name: string; halfLifeHours: number; briefFormat: string; alerts: string; digest: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    halfLifeHours: row.halfLifeHours,
    brief: effectiveBriefFormatOf(row.briefFormat),
    alerts: parseAlerts(row.alerts),
    timeZone: parseTimeZone(row.digest),
  };
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

export interface AnalysisDbFields {
  id: number;
  status: string;
  stage: string | null;
  content: string | null;
  error: string | null;
  model: string | null;
  requestedBy: string;
  requestedAt: number;
  finishedAt: number | null;
}

export const ANALYSIS_COLUMNS = `id, status, stage, content, error, model, requested_by AS requestedBy,
  requested_at AS requestedAt, finished_at AS finishedAt`;

function parseAnalysisContent(text: string | null): AnalysisContent | null {
  const value = parseJson(text);
  return isRecord(value) ? (value as unknown as AnalysisContent) : null;
}

/**
 * The view of an analysis row. "Suggested actions" is a render-time setting
 * (§8.4), so the list is emptied here when the feed has it off now, also for
 * an analysis that was written while it was on.
 */
export function toAnalysisView(row: AnalysisDbFields, suggestedActions: boolean): AnalysisView {
  const status: WorkStatus = (WORK_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as WorkStatus)
    : "queued";
  const content = parseAnalysisContent(row.content);
  return {
    id: row.id,
    status,
    stage: row.stage,
    content: content && !suggestedActions ? { ...content, suggestedActions: [] } : content,
    error: row.error,
    model: row.model,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    finishedAt: row.finishedAt,
  };
}

/** The analysis row of (feed, story) as a view, or null. */
export function readAnalysisView(feed: FeedFacts, storyId: number): AnalysisView | null {
  const row = getSqlite()
    .prepare(`SELECT ${ANALYSIS_COLUMNS} FROM analyses WHERE feed_id = ? AND story_id = ?`)
    .get(feed.id, storyId) as AnalysisDbFields | undefined;
  return row ? toAnalysisView(row, feed.brief.suggestedActions) : null;
}

/** True when the feed has a judgement for the story (the story is part of the feed). */
export function hasJudgement(feedId: number, storyId: number): boolean {
  return (
    getSqlite().prepare("SELECT 1 FROM judgements WHERE feed_id = ? AND story_id = ?").get(feedId, storyId) !== undefined
  );
}
