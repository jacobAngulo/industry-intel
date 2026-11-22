import type { Metadata } from "next";
import type { ReactNode } from "react";

import { requireUser } from "@/app/_lib/identity";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Banners } from "@/components/Banners";
import { TopNav } from "@/components/nav";
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  ChipLink,
  Disclosure,
  EmptyState,
  Field,
  FieldGroup,
  ICONS,
  Icon,
  Input,
  LinkButton,
  Meter,
  NavTabs,
  PageContainer,
  PageHeader,
  RelativeTime,
  SectionHeader,
  SegmentedControl,
  Select,
  SourceTypeIcon,
  Spinner,
  Switch,
  TBody,
  THead,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  fieldDescribedBy,
  type IconName,
} from "@/components/ui";
import type { AppBanner } from "@/lib/services/types";
import { nowMs, HOUR_MS, MINUTE_MS, DAY_MS } from "@/lib/time";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS } from "@/lib/types";

import { DialogDemo, FormStatusDemo, SavedDemo, ToggleDemo } from "./KitDemos";

export const metadata: Metadata = {
  title: "UI kit",
  robots: { index: false, follow: false },
};

// A gallery of the shared UI kit for review in light and dark mode
// (prefers-color-scheme). All text and data on this page are invented.

const SWATCHES = [
  ["bg", "bg-bg"],
  ["surface", "bg-surface"],
  ["surface-2", "bg-surface-2"],
  ["fg", "bg-fg"],
  ["muted", "bg-muted"],
  ["border", "bg-border"],
  ["border-strong", "bg-border-strong"],
  ["accent", "bg-accent"],
  ["accent-soft", "bg-accent-soft"],
  ["alert", "bg-alert"],
  ["alert-soft", "bg-alert-soft"],
  ["warning", "bg-warning"],
  ["warning-soft", "bg-warning-soft"],
  ["success", "bg-success"],
  ["success-soft", "bg-success-soft"],
] as const;

const SAMPLE_BANNERS: AppBanner[] = [
  {
    kind: "worker_down",
    tone: "warning",
    message: "The worker is not running, so nothing new arrives. Start the app with npm run dev or npm start.",
  },
  {
    kind: "model_paused",
    tone: "warning",
    message: "The model is not available now (the service is busy). Judging starts again at 14:30.",
  },
  { kind: "first_run", tone: "info", message: "The first checks run now. Stories show here in a few minutes." },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-border py-8">
      <h2 id={id} className="mb-5 font-serif text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
      <div className="w-40 shrink-0 pt-2 text-sm text-muted">{label}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export default async function KitPage() {
  const now = nowMs();
  await requireUser();

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Development"
        title="UI kit"
        description="Every shared component in each variant and state, with invented data. Switch the system theme to review dark mode."
      />

      <Section id="tokens" title="Colors and type">
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {SWATCHES.map(([name, cls]) => (
            <div key={name} className="flex items-center gap-2 text-sm">
              <span className={`h-8 w-8 shrink-0 rounded-control border border-border ${cls}`} aria-hidden="true" />
              <code>{name}</code>
            </div>
          ))}
        </div>
        <div className="max-w-[860px] space-y-3">
          <p className="font-serif text-2xl leading-snug font-semibold">
            Coding agent adds a sandbox mode for shell commands
          </p>
          <p>
            Body text at 15.5 px with a line height of 1.55. The release adds a sandbox for shell commands and a new
            permission prompt. Teams that run agents in CI can turn it on with one flag.
          </p>
          <p className="text-sm text-muted">Muted text: 3 sources · 4 h ago · Release</p>
          <p className="text-sm">
            Inline code: <code className="rounded bg-surface-2 px-1 py-0.5">--sandbox=strict</code> and a{" "}
            <a href="#tokens" className="text-accent underline">
              text link
            </a>
            .
          </p>
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        <Row label="Variants (md)">
          <Button variant="primary">Save section</Button>
          <Button variant="secondary">Check now</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete source</Button>
        </Row>
        <Row label="Size sm">
          <Button size="sm" variant="primary">
            Useful
          </Button>
          <Button size="sm">Too basic</Button>
          <Button size="sm" variant="ghost">
            Undo
          </Button>
          <Button size="sm" variant="danger">
            Remove
          </Button>
        </Row>
        <Row label="With icon">
          <Button variant="primary" icon="add">
            Add source
          </Button>
          <Button icon="refresh">Check now</Button>
          <Button icon="pause">Pause</Button>
          <Button variant="ghost" iconEnd="arrowRight">
            Next step
          </Button>
        </Row>
        <Row label="Pending, disabled">
          <Button variant="primary" pending pendingLabel="Saving">
            Saving
          </Button>
          <Button pending>Checking</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row label="Link buttons">
          <LinkButton href="/feeds/new" variant="primary" icon="add">
            New feed
          </LinkButton>
          <LinkButton href="/sources">Open the directory</LinkButton>
          <LinkButton href="https://example.com/" external variant="ghost" iconEnd="external">
            Open the origin
          </LinkButton>
        </Row>
        <Row label="Submit (form status)">
          <div className="w-full max-w-xl">
            <FormStatusDemo />
          </div>
        </Row>
        <Row label="Pending, then Saved">
          <SavedDemo />
        </Row>
      </Section>

      <Section id="badges" title="Badges and chips">
        <Row label="Badge tones">
          <Badge>Waiting for first check</Badge>
          <Badge tone="accent">High priority</Badge>
          <Badge tone="alert" icon="alert">
            Failing
          </Badge>
          <Badge tone="warning">Needs token</Badge>
          <Badge tone="success" icon="check">
            Active
          </Badge>
          <Badge tone="alert" strong>
            Alert
          </Badge>
          <Badge tone="neutral" icon="pause">
            Paused
          </Badge>
        </Row>
        <Row label="Chips (static)">
          <Chip>Coding agents</Chip>
          <Chip>Testing and evaluations</Chip>
          <Chip icon="clock">From the show notes only</Chip>
        </Row>
        <Row label="Chip links">
          <ChipLink href="/dev/kit?type=all" selected>
            All
          </ChipLink>
          <ChipLink href="/dev/kit?type=podcast">Podcast</ChipLink>
          <ChipLink href="/dev/kit?type=x_user">X user</ChipLink>
          <ChipLink href="/dev/kit?type=github">GitHub repository</ChipLink>
        </Row>
        <Row label="Chip toggles, switch, radios">
          <ToggleDemo />
        </Row>
      </Section>

      <Section id="cards" title="Card and section header">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <SectionHeader
              title="Brief format"
              description="Summary length, technical depth, and suggested actions."
              actions={
                <Button size="sm" variant="primary">
                  Save
                </Button>
              }
            />
            <p className="mt-3 text-sm text-muted">A plain card: a hairline border on the surface color.</p>
          </Card>
          <Card variant="inset">
            <SectionHeader title="Inset card" description="A quiet fill for a side note or a preview." />
            <p className="mt-3 text-sm">3 of 5 recent items would enter Agentic Development.</p>
          </Card>
        </div>
      </Section>

      <Section id="forms" title="Form controls">
        <div className="grid max-w-3xl gap-6 md:grid-cols-2">
          <Field id="kit-name" label="Feed name" hint="Shown on the tab.">
            <Input
              id="kit-name"
              defaultValue="Agentic Development"
              aria-describedby={fieldDescribedBy("kit-name", { hint: true })}
            />
          </Field>
          <Field id="kit-slug" label="Minimum relevance" error="Enter a number from 0 to 100.">
            <Input
              id="kit-slug"
              type="number"
              defaultValue="140"
              invalid
              aria-describedby={fieldDescribedBy("kit-slug", { error: true })}
            />
          </Field>
          <Field id="kit-owner" label="Owner" optional>
            <Input id="kit-owner" placeholder="A display name" />
          </Field>
          <Field id="kit-disabled" label="Identity (read-only)">
            <Input id="kit-disabled" defaultValue="github:example/agent-cli" disabled />
          </Field>
          <Field id="kit-depth" label="Technical depth">
            <Select
              id="kit-depth"
              defaultValue="practitioner"
              options={[
                { value: "", label: "Use the shared default" },
                { value: "overview", label: "Overview" },
                { value: "practitioner", label: "Practitioner" },
                { value: "deep", label: "Deep" },
              ]}
            />
          </Field>
          <Field id="kit-why" label="Why it matters" hint="Required. One or two sentences." className="md:col-span-2">
            <Textarea
              id="kit-why"
              rows={3}
              defaultValue="Release notes for a coding agent."
              aria-describedby={fieldDescribedBy("kit-why", { hint: true })}
            />
          </Field>
          <FieldGroup legend="Switches" className="md:col-span-2">
            <Switch id="kit-sw-on" name="on" label="Suggested actions" description="Show one line under each brief." defaultChecked />
            <Switch id="kit-sw-off" name="off" label="Quiet hours" />
            <Switch id="kit-sw-dis" name="dis" label="Alerts (disabled)" disabled />
          </FieldGroup>
          <div className="flex flex-col gap-4 md:col-span-2">
            <SegmentedControl
              label="Sort (links)"
              value="top"
              options={[
                { value: "top", label: "Top", href: "/dev/kit?sort=top" },
                { value: "new", label: "Newest", href: "/dev/kit?sort=new" },
              ]}
            />
            <SegmentedControl
              label="Summary length (form radios)"
              name="summaryLength"
              defaultValue="standard"
              options={[
                { value: "short", label: "Short" },
                { value: "standard", label: "Standard" },
                { value: "detailed", label: "Detailed" },
              ]}
            />
            <SegmentedControl
              size="sm"
              label="Priority"
              name="priority"
              defaultValue="normal"
              options={[
                { value: "high", label: "High" },
                { value: "normal", label: "Normal" },
                { value: "low", label: "Low" },
                { value: "muted", label: "Muted", disabled: true },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section id="navigation" title="Navigation">
        <p className="mb-3 text-sm text-muted">A sample of the top navigation (invented feeds; two have an alert dot).</p>
        <div className="mb-6 overflow-hidden rounded-card border border-border">
          <TopNav
            name="Sam Example"
            feeds={[
              { slug: "kit-agentic", name: "Agentic Development", alertIds: [9001] },
              { slug: "kit-platform", name: "Internal AI Platform", alertIds: [] },
              { slug: "kit-radar", name: "Industry Radar", alertIds: [9002, 9003] },
            ]}
          />
        </div>
        <Row label="Feed sections">
          <NavTabs
            label="Feed sections (sample)"
            items={[
              { href: "/dev/kit", label: "Stories", match: "exact" },
              { href: "/dev/kit/digests", label: "Digests" },
              { href: "/dev/kit/settings", label: "Settings" },
            ]}
          />
        </Row>
        <Row label="Pill tabs">
          <NavTabs
            label="Settings groups (sample)"
            variant="pill"
            items={[
              { href: "/dev/kit", label: "Sources", match: "exact" },
              { href: "/dev/kit/profile", label: "Feed Profile" },
              { href: "/dev/kit/interests", label: "Interests" },
              { href: "/dev/kit/delivery", label: "Delivery" },
            ]}
          />
        </Row>
      </Section>

      <Section id="overlays" title="Dialog and disclosure">
        <Row label="Dialog">
          <DialogDemo />
        </Row>
        <Row label="Disclosure (inline)">
          <Disclosure summary="Why this ranks here">
            <ul className="space-y-1 text-sm">
              <li>Relevance 78</li>
              <li>Topic &quot;Coding agents&quot; is high priority: +8</li>
              <li>Corroboration (3 sources): +4.8</li>
              <li className="text-muted">20 h old, effective half-life 144 h: × 0.91 → score 82.6</li>
            </ul>
          </Disclosure>
        </Row>
        <Row label="Disclosure (box)">
          <Disclosure summary="Advanced options" variant="box" className="w-full max-w-lg">
            <p className="text-sm">Check interval, owner, and the identity fields.</p>
          </Disclosure>
        </Row>
      </Section>

      <Section id="banners" title="Banners">
        <div className="flex flex-col gap-3">
          <Banner tone="info" title="This page has no dated entries.">
            New and changed sections become items.
          </Banner>
          <Banner tone="warning" link={{ href: "/status", label: "Open the status page" }}>
            The model is not available now. Judging starts again at 14:30.
          </Banner>
          <Banner
            tone="alert"
            title="Alert: Agentic Development"
            actions={
              <>
                <Button size="sm" variant="secondary">
                  Open story
                </Button>
                <Button size="sm" variant="ghost">
                  Dismiss
                </Button>
              </>
            }
          >
            A security fix in a coding agent that this feed follows. Update before the next release.
          </Banner>
          <Banner tone="warning" density="thin">
            The worker is not running, so nothing new arrives.
          </Banner>
          <p className="mt-2 text-sm text-muted">The Banners component with sample AppBanner values:</p>
          <Banners banners={SAMPLE_BANNERS} />
        </div>
      </Section>

      <Section id="empty" title="Empty state">
        <EmptyState
          icon="inbox"
          title="No stories in this window"
          description={<p>Nothing new in the last 24 hours. Try the wider window.</p>}
          actions={<LinkButton href="/dev/kit?window=week">Show 7 days</LinkButton>}
        />
      </Section>

      <Section id="data" title="Table, time, meter, spinner">
        <Table caption="Health: the last checks (sample)">
          <THead>
            <Tr>
              <Th>Time</Th>
              <Th>Result</Th>
              <Th className="text-right">Items found</Th>
              <Th className="text-right">New</Th>
              <Th>Error</Th>
            </Tr>
          </THead>
          <TBody>
            <Tr>
              <Td>
                <RelativeTime at={now - 12 * MINUTE_MS} now={now} />
              </Td>
              <Td>
                <Badge tone="success" icon="check">
                  OK
                </Badge>
              </Td>
              <Td className="text-right tabular-nums">20</Td>
              <Td className="text-right tabular-nums">2</Td>
              <Td className="text-muted">—</Td>
            </Tr>
            <Tr>
              <Td>
                <RelativeTime at={now - 3 * HOUR_MS} now={now} />
              </Td>
              <Td>
                <Badge tone="alert" icon="failed">
                  Failed
                </Badge>
              </Td>
              <Td className="text-right tabular-nums">0</Td>
              <Td className="text-right tabular-nums">0</Td>
              <Td>The feed address returned 404.</Td>
            </Tr>
          </TBody>
        </Table>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2 text-sm">
            <span>
              Relative (with server time): <RelativeTime at={now - 5 * HOUR_MS} now={now} />
            </span>
            <span>
              Relative (no server time): <RelativeTime at={now - 2 * DAY_MS} />
            </span>
            <span>
              Future: <RelativeTime prefix="Next try" at={now + 40 * MINUTE_MS} now={now} />
            </span>
            <span>
              Old: <RelativeTime at={now - 60 * DAY_MS} now={now} />
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <Meter value={92} />
            <Meter value={71} />
            <Meter value={45} />
            <Meter value={83} label={null} compact />
          </div>
        </div>
        <Row label="Spinner">
          <Spinner />
          <Spinner size={20} />
          <span className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner label={null} /> Reading the sources
          </span>
        </Row>
        {/* AutoRefresh renders nothing; it is off here. */}
        <AutoRefresh everyMs={15_000} active={false} />
      </Section>

      <Section id="icons" title="Icons">
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {(Object.keys(ICONS) as IconName[]).map((name) => (
            <div key={name} className="flex items-center gap-2 text-sm text-muted">
              <Icon name={name} size={16} className="text-fg" />
              <code className="text-xs">{name}</code>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {SOURCE_TYPES.map((type) => (
            <div key={type} className="flex items-center gap-2 text-sm">
              <SourceTypeIcon type={type} className="text-muted" />
              {SOURCE_TYPE_LABELS[type]}
            </div>
          ))}
        </div>
      </Section>
    </PageContainer>
  );
}
