// The types of the services layer: the full text of specification §18.1.
// Pages and Server Actions use these types. Do not change a name or a field
// without a change of the specification.
import type { Candidate } from "@/lib/connectors/types";
import type {
  AlertSettings,
  AnalysisContent,
  BriefFormat,
  BriefFormatOverride,
  Depth,
  DigestEntry,
  DigestSettings,
  FeedbackReason,
  HiddenReason,
  ItemKind,
  Novelty,
  Priority,
  QuietHours,
  RankPart,
  RelevancePriorities,
  SourceType,
  StoryCategory,
  TopicPriority,
} from "@/lib/types";

export interface Actor { name: string; clientId: string }   // name 'Someone' is allowed only for votes

export type ActionResult<T = void> =
  | { ok: true; data: T; message?: string }
  | { ok: false; message: string; code?: 'needs_name' | 'validation' | 'not_found' | 'conflict' | 'limit'; fieldErrors?: Record<string, string> };

export interface FeedSummary { id: number; slug: string; name: string; purpose: string; position: number; archived: boolean;
  sourceCount: number; alertIds: number[] /* visible alerts now, for the tab dot */ }
export interface FeedDetail extends FeedSummary { projectContext: string; minRelevance: number; halfLifeHours: number;
  exclusions: string[]; relevancePriorities: RelevancePriorities; briefFormat: BriefFormatOverride;
  effectiveBriefFormat: BriefFormat; digest: DigestSettings; quietHours: QuietHours; alerts: AlertSettings;
  topicPriorities: Record<number, TopicPriority> }
export interface TopicRow { id: number; slug: string; name: string; description: string; archived: boolean }

export type StoryHidden = HiddenReason | 'my_vote';
export interface StoryCard {
  storyId: number; headline: string; primaryUrl: string | null; summary: string[]; category: StoryCategory;
  basis: 'transcript' | 'show_notes' | null;
  topics: Array<{ id: number; slug: string; name: string }>;
  sources: Array<{ id: number; name: string; type: SourceType }>;
  itemCount: number; sourceCount: number; freshAt: number;
  whyItMatters: string; suggestedAction: string | null; relevance: number; reason: string;
  novelty: Novelty; depth: Depth;
  baseScore: number; score: number; decay: { ageHours: number; halfLifeHours: number; factor: number };
  rankParts: RankPart[]; hidden: StoryHidden | null; exclusion: string | null;
  alert: { id: number } | null;
  votes: Record<FeedbackReason, number>; myVote: FeedbackReason | null;
  analysisStatus: 'none' | 'queued' | 'running' | 'done' | 'failed';
}
export interface StoryList { stories: StoryCard[]; visibleCount: number; filteredCount: number; hasMore: boolean;
  pendingItems: number;
  /** An open re-judge request of the feed: 'backfill' = a source that just joined the feed (request with a source), 'rejudge' = a re-judge of the whole feed. */
  backfill: { done: number; total: number; kind: 'backfill' | 'rejudge' } | null; lastCheckAt: number | null }
export interface StoryItemRow { id: number; sourceId: number; sourceName: string; sourceType: SourceType; title: string;
  url: string | null; author: string | null; publishedAt: number | null; kind: ItemKind; text: string /* '' for long kinds */ }
export interface AnalysisView { id: number; status: 'queued' | 'running' | 'done' | 'failed'; stage: string | null;
  content: AnalysisContent | null; error: string | null; model: string | null; requestedBy: string; requestedAt: number; finishedAt: number | null }
export interface StoryDetail { card: StoryCard; items: StoryItemRow[]; otherFeeds: Array<{ slug: string; name: string }>;
  analysis: AnalysisView | null }

export type SourceStatus = 'paused' | 'needs_token' | 'needs_setup' | 'failing' | 'waiting' | 'active';
export interface SourceRow { id: number; type: SourceType; name: string; url: string | null; status: SourceStatus;
  statusDetail: string | null; feeds: Array<{ id: number; slug: string; name: string }>; lastSuccessAt: number | null;
  usefulStories: number; signalRate: number | null; openFlags: number; addedBy: string; owner: string | null; hints: string[] }
export interface ItemOutcome { itemId: number; title: string; url: string | null; publishedAt: number | null; fetchedAt: number;
  judgeStatus: 'pending' | 'judged' | 'skipped' | 'failed'; skipReason: string | null; storyId: number | null;
  perFeed: Array<{ feedSlug: string; feedName: string; relevance: number | null; hidden: HiddenReason | null }> }
export interface SourceDetail extends SourceRow { why: string; config: unknown; checkIntervalMinutes: number; createdAt: number;
  /** All items of the source (all time), and the stories that only this source has: for the delete dialog. */
  itemCount: number; soleStoryCount: number;
  nextCheckAt: number; checkRequested: boolean; lastError: string | null;
  feedLinks: Array<{ feedId: number; slug: string; name: string; included: boolean; priority: Priority; follow: string; ignore: string }>;
  checks: Array<{ startedAt: number; finishedAt: number; ok: boolean; itemsFound: number; itemsNew: number; error: string | null }>;
  stats: { itemsFetched: number; itemsJudged: number; storiesShown: number; votes: Record<FeedbackReason, number>; signalRate: number | null; usefulStories: number };
  flags: Array<{ id: number; note: string; createdBy: string; createdAt: number; resolvedAt: number | null; resolvedBy: string | null }>;
  recentItems: ItemOutcome[] }

export interface WizardEntry { input: string; candidates: Candidate[]; existing: { id: number; name: string } | null; error?: string }
export interface PreviewItem { externalId: string; title: string; url: string | null; publishedAt: number | null; excerpt: string }
export interface PreviewResult { entries: Array<{ name: string; items: PreviewItem[]; note?: string; error?: string }> }
export interface QualifyResult { available: boolean; unavailableReason?: string;
  perFeed: Array<{ feedId: number; feedName: string; wouldEnter: number; total: number;
    items: Array<{ externalId: string; title: string; relevance: number; reason: string; wouldEnter: boolean; hidden: HiddenReason | null }> }> }
export interface WizardCommon { why: string; feedIds: number[]; follow: string; ignore: string; priority: Priority;
  checkIntervalMinutes: number; owner: string | null }
export interface WizardCreate { entries: Array<{ type: SourceType; name: string; url?: string; config: unknown }>; common: WizardCommon }
export interface Suggestion { feedSlug: string; type: SourceType; name: string; why: string; config: unknown; url?: string }

export interface DigestSummary { id: number; title: string; periodStart: number; periodEnd: number; entryCount: number; createdAt: number }
export interface DigestView extends DigestSummary { entries: Array<DigestEntry & { storyExists: boolean }> }
export interface RejudgeProgress { id: number; feedId: number; status: 'queued' | 'running' | 'done' | 'failed'; total: number; done: number; failed: number }
export interface AppBanner { kind: 'worker_down' | 'no_model_key' | 'model_paused' | 'budget_used' | 'first_run' | 'source_errors';
  tone: 'info' | 'warning'; message: string; link?: { href: string; label: string } }
export interface StatusReport {
  worker: { alive: boolean; lastBeatAt: number | null; hasModelKey: boolean; hasXToken: boolean; hasMailbox: boolean };
  model: { judgeModel: string; analysisModel: string; pausedUntil: number | null; lastError: string | null;
           callsToday: number; callLimit: number; previewCallsToday: number; inputTokensToday: number; outputTokensToday: number };
  x: { postsToday: number; postLimit: number }; webSearch: { searchesToday: number; limit: number };
  queues: { itemsPending: number; itemsFailed: number; analysesQueued: number; rejudgeQueued: number };
  /** The sources whose last check failed (not only those with 3 or more failures), unpaused, worst first. */
  failingSources: Array<{ id: number; name: string; lastError: string | null; nextCheckAt: number; consecutiveFailures: number }>;
  events: Array<{ at: number; level: 'warn' | 'error'; scope: string; message: string }> }
export interface ActivityRow { at: number; actor: string; action: string; entityType: string; entityId: number | null; summary: string }

/**
 * A partial update of the Interests group of a feed (§4.8). Only the keys that
 * are present change; the service merges them into the stored values in one
 * IMMEDIATE transaction, so that a save of one section never reverts a change
 * that another person saved in another section. `topicPriorities` holds only
 * the topics whose priority changed.
 */
export type FeedInterestsPatch = Partial<{
  topicPriorities: Record<number, TopicPriority>;
  exclusions: string[];
  relevancePriorities: RelevancePriorities;
  minRelevance: number;
  halfLifeHours: number;
}>;

/** A partial update of the Delivery group of a feed (§4.8), merged in the same way. */
export type FeedDeliveryPatch = Partial<{
  briefFormat: BriefFormatOverride;
  digest: DigestSettings;
  quietHours: QuietHours;
  alerts: AlertSettings;
}>;
