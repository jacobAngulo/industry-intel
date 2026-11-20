import { Badge } from "@/components/ui";
import type { SourceStatus } from "@/lib/services/types";

import { SOURCE_STATUS_LABELS, SOURCE_STATUS_TONES } from "./labels";

/** The status badge of a source (§10.2). The detail (for example the last error) is in the title. */
export function SourceStatusBadge({ status, detail }: { status: SourceStatus; detail?: string | null }) {
  return (
    <Badge tone={SOURCE_STATUS_TONES[status]} title={detail ?? undefined}>
      {SOURCE_STATUS_LABELS[status]}
    </Badge>
  );
}
