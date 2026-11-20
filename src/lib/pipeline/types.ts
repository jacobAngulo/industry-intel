// The public types of the pipeline (specification §7). index.ts re-exports them.
import type { MailReader } from "@/lib/connectors/types";
import type { SafeHttp } from "@/lib/http/types";
import type { LlmProvider, WebSearchProvider } from "@/lib/llm/types";
import type { HiddenReason } from "@/lib/types";

export interface PipelineDeps {
  llm: LlmProvider;
  http: SafeHttp;
  search: WebSearchProvider | null;
  mail: MailReader | null;
  now: () => number;
}

export type CheckSourceResult = { ran: boolean; ok: boolean; itemsFound: number; itemsNew: number; error?: string };
export type JudgeOutcome = "judged" | "joined" | "regroup" | "retry" | "failed" | "skipped" | "paused";
export type DraftJudgement = {
  feedId: number;
  relevance: number;
  reason: string;
  whyItMatters: string;
  hiddenReason: HiddenReason | null;
};
