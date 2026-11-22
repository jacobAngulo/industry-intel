import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { requireUser } from "@/app/_lib/identity";
import { Banners } from "@/components/Banners";
import { failedChecksText } from "@/components/settings/helpers";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { StatusActions } from "@/components/settings/StatusActions";
import { Badge, PageContainer, PageHeader, RelativeTime, formatAbsoluteUtc } from "@/components/ui";
import { getBanners, getStatus } from "@/lib/services";
import { nowMs } from "@/lib/time";

export const metadata: Metadata = { title: "Status" };

function Facts({ label, rows }: { label: string; rows: Array<[string, ReactNode]> }) {
  return (
    <dl aria-label={label} className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[14rem_minmax(0,1fr)]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd className="mb-2 min-w-0 break-words text-fg sm:mb-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");
const n = (value: number) => value.toLocaleString("en-US");
const ofLimit = (used: number, limit: number) => (Number.isFinite(limit) ? `${n(used)} of ${n(limit)}` : n(used));

/** §4.10 Status: the worker, the model, usage today, queues, failing sources, recent problems. */
export default async function StatusPage() {
  const [status, banners] = await Promise.all([getStatus(), getBanners(), requireUser()]);
  const now = nowMs();
  const { worker, model, queues } = status;
  const paused = model.pausedUntil !== null && model.pausedUntil > now;

  return (
    <PageContainer>
      <PageHeader title="Status" description="What the worker does, what it sees, and what it used today. Day counts use the UTC day." />
      <Banners banners={banners} exclude={["worker_down"]} className="mb-6" />

      <div className="flex flex-col gap-10">
        <SettingsSection id="worker" title="Worker">
          <Facts
            label="Worker"
            rows={[
              [
                "State",
                worker.alive ? (
                  <Badge tone="success" icon="checkCircle">
                    Running
                  </Badge>
                ) : (
                  <Badge tone="alert" icon="alert">
                    Not running
                  </Badge>
                ),
              ],
              ["Last heartbeat", worker.lastBeatAt ? <RelativeTime at={worker.lastBeatAt} now={now} /> : "Never"],
              ["Model key", yesNo(worker.hasModelKey)],
              ["X token", yesNo(worker.hasXToken)],
              ["Mailbox", yesNo(worker.hasMailbox)],
            ]}
          />
          {!worker.alive ? (
            <p className="mt-3 text-sm text-muted">
              The key facts come from the last heartbeat of the worker. Start the app with npm run dev or npm start.
            </p>
          ) : null}
        </SettingsSection>

        <SettingsSection id="model" title="Model">
          <Facts
            label="Model"
            rows={[
              ["Model for judging", <code key="j">{model.judgeModel}</code>],
              ["Model for analyses", <code key="a">{model.analysisModel}</code>],
              [
                "Paused until",
                paused && model.pausedUntil ? (
                  <span title={formatAbsoluteUtc(model.pausedUntil)}>
                    <RelativeTime at={model.pausedUntil} now={now} />
                  </span>
                ) : (
                  "Not paused"
                ),
              ],
              ["Last error", model.lastError ?? "None"],
              ["Calls today", ofLimit(model.callsToday, model.callLimit)],
              ["Tokens today", `${n(model.inputTokensToday)} in · ${n(model.outputTokensToday)} out`],
              ["Preview calls today", n(model.previewCallsToday)],
            ]}
          />
        </SettingsSection>

        <SettingsSection id="usage" title="Other usage today">
          <Facts
            label="Other usage today"
            rows={[
              ["X posts read", ofLimit(status.x.postsToday, status.x.postLimit)],
              ["Web searches", ofLimit(status.webSearch.searchesToday, status.webSearch.limit)],
            ]}
          />
        </SettingsSection>

        <SettingsSection id="queues" title="Queues">
          <Facts
            label="Queues"
            rows={[
              ["Items that wait for the model", n(queues.itemsPending)],
              ["Failed items", n(queues.itemsFailed)],
              ["Analyses queued", n(queues.analysesQueued)],
              ["Re-judge work", n(queues.rejudgeQueued)],
            ]}
          />
          <div className="mt-6">
            <StatusActions failedItems={queues.itemsFailed} />
          </div>
        </SettingsSection>

        <SettingsSection id="failing" title="Failing sources">
          {status.failingSources.length === 0 ? (
            <p className="text-sm text-muted">No source is failing.</p>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {status.failingSources.map((s) => (
                <li key={s.id} className="flex flex-col gap-1 py-3 text-sm">
                  <Link href={`/sources/${s.id}`} className="font-medium">
                    {s.name}
                  </Link>
                  <p className="text-muted">{failedChecksText(s.consecutiveFailures)}</p>
                  {s.lastError ? <p className="break-words text-muted">{s.lastError}</p> : null}
                  <p className="text-muted">
                    Next try: <RelativeTime at={s.nextCheckAt} now={now} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>

        <SettingsSection id="events" title="Recent problems" description="The last 50 warnings and errors of the worker and the app.">
          {status.events.length === 0 ? (
            <p className="text-sm text-muted">No warning or error.</p>
          ) : (
            <ol className="divide-y divide-border border-y border-border">
              {status.events.map((event, i) => (
                <li key={`${event.at}-${i}`} className="flex flex-col gap-1 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2 text-muted">
                    <RelativeTime at={event.at} now={now} />
                    <Badge tone={event.level === "error" ? "alert" : "warning"}>
                      {event.level === "error" ? "Error" : "Warning"}
                    </Badge>
                    <code className="text-xs">{event.scope}</code>
                  </div>
                  <p className="break-words text-fg">{event.message}</p>
                </li>
              ))}
            </ol>
          )}
        </SettingsSection>
      </div>
    </PageContainer>
  );
}
