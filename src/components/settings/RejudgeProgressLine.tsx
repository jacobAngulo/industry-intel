import { AutoRefresh } from "@/components/AutoRefresh";
import { Icon, Spinner, cn } from "@/components/ui";
import type { RejudgeProgress } from "@/lib/services/types";

import { rejudgeProgressText } from "./helpers";

export interface RejudgeProgressLineProps {
  progress: RejudgeProgress | null;
  /** A feed name before the text (the shared settings list one line for each feed). */
  feedName?: string;
  /** Show a finished request too (default true). */
  showFinished?: boolean;
  className?: string;
}

/**
 * "Re-judging: N of M done" (§4.8). While the request is queued or running the
 * page refreshes each 2 s (<AutoRefresh>, the only polling method).
 */
export function RejudgeProgressLine({ progress, feedName, showFinished = true, className }: RejudgeProgressLineProps) {
  if (!progress) return null;
  const open = progress.status === "queued" || progress.status === "running";
  if (!open && !showFinished) return null;
  return (
    <div role="status" className={cn("flex items-start gap-2 text-sm", open ? "text-fg" : "text-muted", className)}>
      {open ? (
        <Spinner size={14} label={null} className="mt-[3px]" />
      ) : (
        <Icon name={progress.status === "failed" ? "warning" : "checkCircle"} size={14} className="mt-[3px]" />
      )}
      <span>
        {feedName ? <span className="font-medium">{feedName}: </span> : null}
        {rejudgeProgressText(progress)}
      </span>
      <AutoRefresh everyMs={2000} active={open} />
    </div>
  );
}
