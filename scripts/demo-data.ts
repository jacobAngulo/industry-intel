// Fills a database with invented data for page work.
//
//   DATABASE_PATH=<file> npx tsx scripts/demo-data.ts
//
// - It refuses to run when DATABASE_PATH is not set, when it resolves to the
//   default data/app.db (the database of the owner), or when the database
//   has a feed already.
// - It does not read `.env`, it makes no network call, and it needs no key.
// - Every invented text starts with "[demo]". The feeds and the topics are
//   the ones of specification §12.
import { count, eq } from "drizzle-orm";

import { parseConfig, sourceKey } from "@/lib/connectors/configs";
import { closeDb, openDatabase, setDbHandleForTests } from "@/lib/db/client";
import { upsertStoryFts } from "@/lib/db/fts";
import { defaultDatabasePath, resolveDatabasePathFrom } from "@/lib/db/path";
import * as schema from "@/lib/db/schema";
import { baseScore, type RankInput } from "@/lib/ranking";
import {
  DEFAULT_BRIEF_FORMAT,
  DEFAULT_EXCLUSIONS,
  DEFAULT_RELEVANCE_PRIORITIES,
  EMPTY_BRIEF_FORMAT_OVERRIDE,
  SOURCE_TYPE_DEFAULTS,
  defaultFeedDefaults,
  emptyVotes,
  serverTimeZone,
  type AnalysisContent,
  type Depth,
  type DigestEntry,
  type FeedbackReason,
  type HiddenReason,
  type ItemKind,
  type Novelty,
  type Priority,
  type RankPart,
  type Signals,
  type SourceType,
  type StoryCategory,
  type Substance,
  type TeamProfile,
  type TopicPriority,
  type WorkerHeartbeat,
} from "@/lib/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D = "[demo]";

function fail(message: string): never {
  console.error(`demo-data: ${message}`);
  process.exit(1);
}

// --- guards ---------------------------------------------------------------

const configured = process.env.DATABASE_PATH?.trim();
if (!configured) {
  fail("DATABASE_PATH is not set. Use: DATABASE_PATH=<file> npx tsx scripts/demo-data.ts");
}
const file = resolveDatabasePathFrom(configured);
if (file === defaultDatabasePath()) {
  fail("DATABASE_PATH is the default data/app.db. That is the database of the owner. Give a different file.");
}

const handle = openDatabase(file, { seed: false });
setDbHandleForTests(handle);
const { db, sqlite } = handle;

if ((db.select({ n: count() }).from(schema.feeds).get()?.n ?? 0) > 0) {
  closeDb();
  fail(`The database ${file} has feeds already. Delete the file (and its -wal / -shm files), or give a new path.`);
}

// --- definitions ------------------------------------------------------------

const now = Date.now();
const timeZone = serverTimeZone();

type FeedKey = "AD" | "IP" | "IR";
type SourceKey = "gh" | "blog" | "docs" | "pod" | "hn" | "yt" | "arxiv" | "news" | "web" | "xuser" | "xsearch";

const TOPICS: Array<[name: string, description: string]> = [
  ["Coding agents", "Tools that write and change code with a model: releases, capabilities, limits."],
  ["Agent workflows", "How teams plan, run, and review work that agents do."],
  ["Testing and evaluations", "Tests and evaluations for agents and for code that agents write."],
  ["Document processing", "Extraction, parsing, and search over documents with models."],
  ["Microsoft Foundry", "The Microsoft Foundry platform: agents, models, changes, deprecations."],
  ["Permissions and data access", "How people and agents get access to data, and how to limit it."],
  ["Orchestration", "How to connect agents, tools, and services into one system."],
  ["Enterprise deployment", "Networking, security, cost, and operations of AI apps in a company."],
  ["Model releases", "New models and important changes to existing models."],
  ["Company announcements", "Announcements of companies that can change the direction of the tracked projects."],
];

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The local hour (0..23) of an instant in a time zone. */
function localHour(instant: number, zone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(instant);
  return Number(hour) % 24;
}
const clock = (hour: number) => `${String(((hour % 24) + 24) % 24).padStart(2, "0")}:00`;
const hourNow = localHour(now, timeZone);

interface FeedDef {
  key: FeedKey;
  name: string;
  purpose: string;
  projectContext: string;
  high: string[];
  low?: string[];
  muted?: string[];
  halfLifeHours?: number;
  technicalDepth?: "overview";
  priorities: { practical: "normal" | "strong"; experiment: "normal" | "strong" };
  alertRule: string;
  alertsOn: boolean;
  quietNow: boolean;
}

const FEEDS: FeedDef[] = [
  {
    key: "AD",
    name: "Agentic Development",
    purpose: "Coding agents, agent workflows, testing, and evaluations for projects built with agents.",
    projectContext: `${D} Internal tools for three teams, built with coding agents. The agents run in CI and on developer machines. Current projects: a support assistant for the service desk; an agent that updates dependencies in 40 repositories.`,
    high: ["Coding agents", "Agent workflows", "Testing and evaluations"],
    low: ["Document processing"],
    muted: ["Company announcements"],
    priorities: { practical: "strong", experiment: "normal" },
    alertRule:
      "A security problem or a breaking change in a coding agent or an agent tool that this feed follows; a major release of a coding agent.",
    alertsOn: true,
    quietNow: false,
  },
  {
    key: "IP",
    name: "Internal AI Platform",
    purpose: "Foundry, permissions, data access, and orchestration for the in-house AI app.",
    projectContext: `${D} The in-house AI app gives each team an assistant with access to the data of that team only.`,
    high: ["Microsoft Foundry", "Permissions and data access", "Orchestration", "Enterprise deployment"],
    priorities: { practical: "normal", experiment: "normal" },
    alertRule:
      "A deprecation, a breaking change, or a security notice that affects Microsoft Foundry or the way teams get access to data.",
    alertsOn: true,
    quietNow: true,
  },
  {
    key: "IR",
    name: "Industry Radar",
    purpose: "Broader developments from podcasts, X, and company announcements that can change the direction of the tracked projects.",
    projectContext: "",
    high: ["Model releases", "Company announcements"],
    halfLifeHours: 36,
    technicalDepth: "overview",
    priorities: { practical: "normal", experiment: "normal" },
    alertRule: "",
    alertsOn: false,
    quietNow: false,
  },
];

interface SourceDef {
  key: SourceKey;
  type: SourceType;
  name: string;
  url: string;
  config: unknown;
  why: string;
  owner?: string;
  state: "active" | "paused" | "failing" | "waiting";
  feeds: Array<{ feed: FeedKey; priority: Priority; follow?: string; ignore?: string }>;
  flags?: Array<{ note: string; by: string; resolved?: boolean }>;
  kind: ItemKind;
}

const SOURCES: SourceDef[] = [
  {
    key: "gh",
    type: "github",
    name: `${D} Example Agent releases`,
    url: "https://github.com/example-demo/example-agent/releases",
    config: { owner: "example-demo", repo: "example-agent", advisories: true },
    why: `${D} Releases of a coding agent that is in daily use.`,
    owner: "Dana",
    state: "active",
    feeds: [{ feed: "AD", priority: "high" }],
    kind: "release",
  },
  {
    key: "blog",
    type: "blog",
    name: `${D} Example Engineering blog`,
    url: "https://engineering.example.com/",
    config: { feedUrl: "https://engineering.example.com/feed.xml", siteUrl: "https://engineering.example.com/" },
    why: `${D} First-hand reports from a team that builds with agents.`,
    owner: "Sam",
    state: "active",
    feeds: [
      { feed: "AD", priority: "normal" },
      { feed: "IP", priority: "normal", follow: "platform, permissions, orchestration" },
    ],
    kind: "article",
  },
  {
    key: "docs",
    type: "docs",
    name: `${D} Foundry: What's new`,
    url: "https://docs.example.com/foundry/whats-new",
    config: { url: "https://docs.example.com/foundry/whats-new", mode: "auto" },
    why: `${D} Directly affects the internal AI app.`,
    owner: "Dana",
    state: "active",
    feeds: [
      {
        feed: "IP",
        priority: "high",
        follow: "agents, permissions, private networking",
        ignore: "cosmetic documentation edits",
      },
    ],
    kind: "doc_change",
  },
  {
    key: "pod",
    type: "podcast",
    name: `${D} The Agent Hour`,
    url: "https://podcast.example.com/agent-hour",
    config: { feedUrl: "https://podcast.example.com/agent-hour/feed.xml", show: "The Agent Hour" },
    why: `${D} Weekly talk about the business side of AI.`,
    state: "active",
    feeds: [{ feed: "IR", priority: "normal" }],
    kind: "episode",
  },
  {
    key: "hn",
    type: "community",
    name: `${D} Hacker News: "coding agent"`,
    url: "https://hn.example.com/?q=coding+agent",
    config: { variant: "hn", query: "demo coding agent", minPoints: 100 },
    why: `${D} Discussions that many engineers voted for.`,
    state: "active",
    feeds: [{ feed: "AD", priority: "low", ignore: "hiring threads" }],
    flags: [
      { note: `${D} Too many opinion threads with no new facts.`, by: "Sam" },
      { note: `${D} Half of the threads repeat the release notes.`, by: "Priya" },
      { note: `${D} Was noisy during the launch week.`, by: "Dana", resolved: true },
    ],
    kind: "thread",
  },
  {
    key: "yt",
    type: "youtube",
    name: `${D} Agent Talks channel`,
    url: "https://video.example.com/@agent-talks",
    config: { variant: "channel", channelId: "UCdemo0000000000000000001", title: "Agent Talks" },
    why: `${D} Conference talks and demos.`,
    state: "paused",
    feeds: [{ feed: "IR", priority: "normal" }],
    kind: "video",
  },
  {
    key: "arxiv",
    type: "research",
    name: `${D} arXiv: agent evaluation`,
    url: "https://papers.example.com/list?q=agent+evaluation",
    config: { variant: "arxiv_query", query: "demo agent evaluation", categories: ["cs.AI", "cs.SE"] },
    why: `${D} New evaluation methods for agents.`,
    owner: "Priya",
    state: "failing",
    feeds: [{ feed: "AD", priority: "normal" }],
    kind: "paper",
  },
  {
    key: "news",
    type: "newsletter",
    name: `${D} The Platform Weekly`,
    url: "https://weekly.example.com/",
    config: { variant: "feed", feedUrl: "https://weekly.example.com/feed" },
    why: `${D} A weekly summary for platform teams.`,
    state: "active",
    feeds: [],
    kind: "article",
  },
  {
    key: "web",
    type: "web_search",
    name: `${D} Web search: agent orchestration`,
    url: "https://search.example.com/?q=agent+orchestration",
    config: { query: "demo agent orchestration patterns", allowedDomains: ["example.com", "example.org"] },
    why: `${D} Finds new sources about orchestration.`,
    state: "active",
    feeds: [{ feed: "IP", priority: "normal" }],
    kind: "search_result",
  },
  {
    key: "xuser",
    type: "x_user",
    name: `${D} @demo_investor`,
    url: "https://x.com/demo_investor",
    config: { username: "demo_investor" },
    why: `${D} Posts early about company announcements.`,
    state: "active",
    feeds: [{ feed: "IR", priority: "normal" }],
    kind: "post",
  },
  {
    key: "xsearch",
    type: "x_search",
    name: `${D} X keyword: demo coding agents`,
    url: "https://x.com/search?q=demo+coding+agents",
    config: { query: "demo coding agents" },
    why: `${D} The most liked posts about coding agents.`,
    state: "waiting",
    feeds: [{ feed: "IR", priority: "normal" }],
    kind: "post",
  },
];

interface JudgementDef {
  feed: FeedKey;
  relevance: number;
  topics?: string[];
  hidden?: HiddenReason;
  exclusion?: string;
  novelty?: Novelty;
  depth?: Depth;
  /** [practical, (no longer used), experiment] */
  signals?: [number, number, number];
  action?: string;
  alert?: boolean;
  votes?: Partial<Record<FeedbackReason, number>>;
}

interface StoryDef {
  headline: string;
  summary: string[];
  category: StoryCategory;
  substance: Substance;
  entities: string[];
  ageHours: number;
  items: SourceKey[];
  basis?: "transcript" | "show_notes";
  judgements: JudgementDef[];
}

const s = (text: string) => `${D} ${text}`;

const STORIES: StoryDef[] = [
  // --- Agentic Development -------------------------------------------------
  {
    headline: s("Example Agent 4.0 adds background tasks and a permission mode for CI"),
    summary: [
      s("Example Agent 4.0 runs long tasks in the background and reports when they finish."),
      s("A new permission mode lets a CI job approve a fixed list of commands."),
      s("The release changes the format of the settings file; the old format works until version 5."),
      s("The maintainers measured 30 % fewer approval prompts in their own repositories."),
      s("The upgrade needs Node 20 or later."),
    ],
    category: "release",
    substance: "news",
    entities: ["Example Agent", "Example Labs"],
    ageHours: 20,
    items: ["gh", "blog", "hn"],
    judgements: [
      {
        feed: "AD",
        relevance: 93,
        topics: ["Coding agents", "Agent workflows"],
        signals: [3, 3, 2],
        action: s("Upgrade one repository to 4.0 and test the CI permission mode."),
        votes: { useful: 3 },
      },
      {
        feed: "IP",
        relevance: 71,
        topics: ["Permissions and data access"],
        signals: [2, 1, 1],
        action: s("Compare the permission mode with the access rules of the platform."),
      },
    ],
  },
  {
    headline: s("Example Agent 4.0.1 fixes a sandbox escape in the shell tool"),
    summary: [
      s("Version 4.0.1 fixes a bug that let a crafted file name run a command outside the sandbox."),
      s("All 4.0 installs are affected; versions before 4.0 are not."),
      s("The advisory rates the problem as high severity."),
    ],
    category: "security",
    substance: "news",
    entities: ["Example Agent"],
    ageHours: 3,
    items: ["gh"],
    judgements: [
      {
        feed: "AD",
        relevance: 96,
        topics: ["Coding agents"],
        signals: [3, 3, 0],
        action: s("Upgrade every 4.0 install to 4.0.1 today."),
        alert: true,
      },
    ],
  },
  {
    headline: s("A team reports results from 3 months of tests written by agents"),
    summary: [
      s("An engineering team let agents write the unit tests for 40 services."),
      s("Coverage went from 61 % to 84 %, and 12 % of the new tests needed a manual fix."),
      s("The team keeps a human review for tests of payment code."),
    ],
    category: "practice",
    substance: "report",
    entities: ["Example Engineering"],
    ageHours: 30,
    items: ["blog", "hn"],
    judgements: [
      {
        feed: "AD",
        relevance: 84,
        topics: ["Testing and evaluations", "Agent workflows"],
        signals: [3, 1, 2],
        action: s("Try the review checklist of the report on one service."),
        votes: { useful: 2, already_knew: 1 },
      },
    ],
  },
  {
    headline: s("New benchmark measures how coding agents handle large refactors"),
    summary: [
      s("A paper introduces a benchmark of 200 refactoring tasks across 15 repositories."),
      s("The best agent completes 46 % of the tasks with no failed test."),
      s("The tasks and the scoring code are public."),
    ],
    category: "research",
    substance: "news",
    entities: ["RefactorBench (demo)"],
    ageHours: 52,
    items: ["arxiv"],
    judgements: [
      { feed: "AD", relevance: 78, topics: ["Testing and evaluations", "Coding agents"], depth: "advanced", signals: [1, 1, 3] },
    ],
  },
  {
    headline: s("Guide: structure a repository so that agents find context faster"),
    summary: [
      s("The guide recommends one short instruction file for each package."),
      s("It shows how to keep build commands and test commands in one place."),
      s("The author measured fewer wrong edits after the change."),
    ],
    category: "practice",
    substance: "analysis",
    entities: ["Example Engineering"],
    ageHours: 70,
    items: ["blog"],
    judgements: [
      { feed: "AD", relevance: 74, topics: ["Agent workflows"], signals: [3, 1, 1], action: s("Add an instruction file to the two largest packages.") },
      { feed: "IP", relevance: 52, hidden: "below_threshold", signals: [1, 0, 0] },
    ],
  },
  {
    headline: s("Discussion compares designs of agent harnesses"),
    summary: [
      s("A long thread compares three ways to give an agent its tools."),
      s("Several engineers report that fewer tools gave better results."),
    ],
    category: "discussion",
    substance: "analysis",
    entities: [],
    ageHours: 96,
    items: ["hn"],
    judgements: [{ feed: "AD", relevance: 66, topics: ["Agent workflows"], signals: [1, 1, 2] }],
  },
  {
    headline: s("Example Agent adds a plugin marketplace"),
    summary: [
      s("Example Agent now installs plugins from a public marketplace."),
      s("Each plugin declares the permissions that it needs."),
      s("An organization can limit the installs to an approved list."),
    ],
    category: "feature",
    substance: "news",
    entities: ["Example Agent"],
    ageHours: 120,
    items: ["gh", "blog"],
    judgements: [
      { feed: "AD", relevance: 81, topics: ["Coding agents"], novelty: "update", signals: [2, 2, 2], action: s("Decide which plugins the teams can install.") },
    ],
  },
  {
    headline: s("Vendor webinar promotes an agent readiness assessment"),
    summary: [s("A vendor invites teams to a webinar about its paid readiness assessment.")],
    category: "business",
    substance: "promo",
    entities: ["Example Consulting"],
    ageHours: 40,
    items: ["blog"],
    judgements: [{ feed: "AD", relevance: 35, hidden: "low_substance", depth: "basic", signals: [0, 0, 0] }],
  },
  {
    headline: s("Opinion thread: agents will replace code review"),
    summary: [s("A thread argues that code review becomes unnecessary."), s("The thread gives no data.")],
    category: "opinion",
    substance: "analysis",
    entities: [],
    ageHours: 60,
    items: ["hn"],
    judgements: [
      { feed: "AD", relevance: 68, topics: ["Agent workflows"], hidden: "feedback", signals: [0, 0, 1], votes: { off_topic: 2 } },
    ],
  },
  {
    headline: s("Tutorial: write your first prompt for a coding agent"),
    summary: [s("A tutorial for people who never used a coding agent."), s("It explains how to describe a task in one paragraph.")],
    category: "practice",
    substance: "analysis",
    entities: [],
    ageHours: 80,
    items: ["blog"],
    judgements: [
      { feed: "AD", relevance: 62, topics: ["Coding agents"], hidden: "exclusion", exclusion: "Beginner tutorials", depth: "basic", signals: [1, 0, 0] },
    ],
  },
  {
    headline: s("Paper: evaluation of multi-agent planning when tools fail"),
    summary: [
      s("The paper tests how four planning methods recover when a tool call fails."),
      s("Methods that re-plan after each failure finish 22 % more tasks."),
    ],
    category: "research",
    substance: "report",
    entities: [],
    ageHours: 140,
    items: ["arxiv"],
    judgements: [
      { feed: "AD", relevance: 72, topics: ["Testing and evaluations"], depth: "advanced", signals: [1, 0, 2], votes: { too_basic: 1 } },
    ],
  },
  {
    headline: s("Example Agent 3.9: a recap of the changelog"),
    summary: [s("A recap of changes that Example Agent 3.9 released last month.")],
    category: "release",
    substance: "news",
    entities: ["Example Agent"],
    ageHours: 200,
    items: ["gh"],
    judgements: [{ feed: "AD", relevance: 58, topics: ["Coding agents"], hidden: "below_threshold", novelty: "repeat", signals: [1, 1, 0] }],
  },
  {
    headline: s("An agent testing startup announces a partnership"),
    summary: [s("A startup that tests agents announces a partnership with a cloud vendor."), s("The post gives no technical detail.")],
    category: "business",
    substance: "news",
    entities: ["Example Testing Co"],
    ageHours: 150,
    items: ["hn"],
    judgements: [{ feed: "AD", relevance: 63, topics: ["Company announcements"], hidden: "muted_topic", signals: [0, 0, 0] }],
  },
  // --- Internal AI Platform ------------------------------------------------
  {
    headline: s("Foundry deprecates the classic agents API in March"),
    summary: [
      s("The classic agents API of Foundry stops in March."),
      s("Apps must move to the new agent service; the page links a migration guide."),
      s("Threads that the classic API stored are not moved automatically."),
    ],
    category: "release",
    substance: "news",
    entities: ["Microsoft Foundry"],
    ageHours: 5,
    items: ["docs", "blog"],
    judgements: [
      {
        feed: "IP",
        relevance: 95,
        topics: ["Microsoft Foundry", "Enterprise deployment"],
        signals: [3, 3, 0],
        action: s("List the services that call the classic agents API."),
        alert: true,
      },
      { feed: "AD", relevance: 61, signals: [1, 2, 0] },
    ],
  },
  {
    headline: s("Foundry adds private networking for hosted agents"),
    summary: [
      s("Hosted agents in Foundry can now run inside a private network."),
      s("Outbound calls of an agent can be limited to an allow list."),
      s("The feature is in preview in four regions."),
    ],
    category: "feature",
    substance: "news",
    entities: ["Microsoft Foundry"],
    ageHours: 28,
    items: ["docs"],
    judgements: [
      {
        feed: "IP",
        relevance: 90,
        topics: ["Microsoft Foundry", "Enterprise deployment"],
        signals: [2, 3, 2],
        action: s("Test private networking in the staging subscription."),
      },
    ],
  },
  {
    headline: s("Foundry changes the default permission scope of connectors"),
    summary: [
      s("New connectors in Foundry get read-only access by default."),
      s("Existing connectors keep their scope until an administrator changes it."),
    ],
    category: "feature",
    substance: "news",
    entities: ["Microsoft Foundry"],
    ageHours: 50,
    items: ["docs"],
    judgements: [
      {
        feed: "IP",
        relevance: 88,
        topics: ["Permissions and data access", "Microsoft Foundry"],
        signals: [2, 3, 1],
        action: s("Review the scope of the five connectors that the app uses."),
        votes: { useful: 1 },
      },
    ],
  },
  {
    headline: s("Guide: map team roles to data access for an internal AI app"),
    summary: [
      s("The guide shows a role model with three levels of data access."),
      s("It explains how to test that an assistant never reads data of another team."),
    ],
    category: "practice",
    substance: "analysis",
    entities: ["Example Engineering"],
    ageHours: 75,
    items: ["blog"],
    judgements: [
      { feed: "IP", relevance: 79, topics: ["Permissions and data access"], signals: [3, 2, 1], action: s("Compare the role model with our access table.") },
      { feed: "AD", relevance: 48, hidden: "below_threshold", signals: [1, 0, 0] },
    ],
  },
  {
    headline: s("Orchestration pattern: a queue between the agent and its tools"),
    summary: [
      s("A team put a queue between its agents and slow tools."),
      s("Timeouts went down, and a failed tool call can run again without a new model call."),
    ],
    category: "practice",
    substance: "report",
    entities: [],
    ageHours: 100,
    items: ["blog", "web"],
    judgements: [{ feed: "IP", relevance: 76, topics: ["Orchestration"], signals: [2, 1, 3] }],
  },
  {
    headline: s("Foundry documentation: wording changes in the quickstart"),
    summary: [s("The quickstart page has new wording in two paragraphs."), s("No behavior changed.")],
    category: "other",
    substance: "news",
    entities: ["Microsoft Foundry"],
    ageHours: 33,
    items: ["docs"],
    judgements: [
      { feed: "IP", relevance: 30, topics: ["Microsoft Foundry"], hidden: "exclusion", exclusion: "source filter", depth: "basic", signals: [0, 0, 0] },
    ],
  },
  {
    headline: s("Model Context Protocol proposes a new authorization flow"),
    summary: [
      s("A proposal changes how a client gets a token for a tool server."),
      s("Servers can ask for a narrower scope for each tool."),
      s("The proposal is open for comments for 30 days."),
    ],
    category: "release",
    substance: "news",
    entities: ["Model Context Protocol"],
    ageHours: 44,
    items: ["web", "blog"],
    judgements: [
      { feed: "IP", relevance: 83, topics: ["Permissions and data access", "Orchestration"], signals: [1, 3, 2], action: s("Read the proposal and note the effect on our tool servers.") },
      { feed: "AD", relevance: 77, topics: ["Coding agents"], signals: [1, 2, 2] },
    ],
  },
  {
    headline: s("Report: the cost of an internal AI platform for 500 users"),
    summary: [
      s("A company publishes the monthly cost of its internal AI platform."),
      s("Model calls are 58 % of the cost; search and storage are 27 %."),
    ],
    category: "business",
    substance: "report",
    entities: [],
    ageHours: 190,
    items: ["web"],
    judgements: [{ feed: "IP", relevance: 69, topics: ["Enterprise deployment"], signals: [1, 1, 1] }],
  },
  // --- Industry Radar ------------------------------------------------------
  {
    headline: s("Podcast: hosts discuss agent pricing and enterprise budgets"),
    summary: [s("The episode covers agent pricing, enterprise budgets, and seat licenses.")],
    category: "discussion",
    substance: "analysis",
    entities: ["The Agent Hour"],
    ageHours: 26,
    items: ["pod"],
    basis: "show_notes",
    judgements: [{ feed: "IR", relevance: 66, topics: ["Company announcements"], depth: "basic", signals: [0, 1, 0] }],
  },
  {
    headline: s("Podcast: an interview about in-house AI platforms at large companies"),
    summary: [
      s("A platform lead describes how a company of 20 000 people built its own AI platform."),
      s("The company moved from one shared assistant to one assistant for each team."),
      s("The guest says that access rules took more time than the model work."),
    ],
    category: "discussion",
    substance: "report",
    entities: ["The Agent Hour"],
    ageHours: 170,
    items: ["pod"],
    basis: "transcript",
    judgements: [{ feed: "IR", relevance: 80, topics: ["Company announcements"], signals: [2, 2, 1] }],
  },
  {
    headline: s("A lab announces a flagship model with a larger context window"),
    summary: [
      s("A lab announces a new flagship model."),
      s("The context window is two times as large as before."),
      s("The price for each token stays the same."),
    ],
    category: "model",
    substance: "news",
    entities: ["Example Labs"],
    ageHours: 12,
    items: ["xuser", "yt", "pod"],
    judgements: [{ feed: "IR", relevance: 86, topics: ["Model releases"], signals: [2, 2, 3], votes: { useful: 2 } }],
  },
  {
    headline: s("A cloud vendor cuts prices for hosted model inference"),
    summary: [s("A cloud vendor cuts the price of hosted inference by 20 %."), s("The cut applies to all regions next month.")],
    category: "business",
    substance: "news",
    entities: ["Example Cloud"],
    ageHours: 58,
    items: ["xuser"],
    judgements: [{ feed: "IR", relevance: 73, topics: ["Company announcements"], signals: [1, 2, 0] }],
  },
  {
    headline: s("Conference talk: lessons from 100 agent deployments"),
    summary: [
      s("A talk summarizes 100 deployments of agents in companies."),
      s("Most failed projects had no owner for the evaluation."),
    ],
    category: "practice",
    substance: "report",
    entities: ["Agent Talks"],
    ageHours: 110,
    items: ["yt"],
    judgements: [{ feed: "IR", relevance: 71, topics: [], signals: [2, 1, 1] }],
  },
  {
    headline: s("Post: a prediction about agent adoption in 2027"),
    summary: [s("A post predicts that most code changes come from agents in 2027.")],
    category: "opinion",
    substance: "chatter",
    entities: [],
    ageHours: 36,
    items: ["xuser"],
    judgements: [{ feed: "IR", relevance: 44, hidden: "low_substance", depth: "basic", signals: [0, 0, 0] }],
  },
  {
    headline: s("Newsletter issue: platform teams and AI budgets"),
    summary: [s("The issue collects five articles about budgets of platform teams.")],
    category: "business",
    substance: "analysis",
    entities: ["The Platform Weekly"],
    ageHours: 90,
    items: ["news"],
    // The newsletter is in no feed now, so this judgement is hidden.
    judgements: [{ feed: "IR", relevance: 64, hidden: "source_removed", signals: [1, 0, 0] }],
  },
];

// --- rank values --------------------------------------------------------------

/** Uses baseScore of src/lib/ranking when it is implemented. In phase 1 it is a stub. */
function realRank(input: RankInput): { base: number; parts: RankPart[] } | null {
  try {
    return baseScore(input);
  } catch {
    return null;
  }
}

/** Plausible values by hand: the main terms of specification §8.2. */
function handRank(input: RankInput): { base: number; parts: RankPart[] } {
  const parts: RankPart[] = [{ key: "relevance", label: "Relevance", value: input.relevance }];
  const add = (key: string, label: string, value: number, detail?: string) => {
    if (value !== 0) parts.push({ key, label, value: Math.round(value * 10) / 10, ...(detail ? { detail } : {}) });
  };
  const highIndex = input.topicPriorities.indexOf("high");
  if (highIndex >= 0) add("topic", `Topic "${input.topicNames[highIndex]}" is high priority`, 8);
  else if (input.topicPriorities.length > 0 && input.topicPriorities.every((p) => p === "low")) {
    add("topic", "All matched topics are low priority", -8);
  }
  const weight = { off: 0, normal: 1, strong: 2 } as const;
  const p =
    (weight[input.priorities.practical] * (input.signals.practical - 1.5) +
      weight[input.priorities.experiment] * (input.signals.experiment - 1.5)) *
    (4 / 3);
  add("priorities", "Relevance priorities of the feed", p);
  if (input.sourcePriority === "high") add("source_priority", "A source with high priority in this feed", 5);
  if (input.sourcePriority === "low") add("source_priority", "A source with low priority in this feed", -5);
  add("corroboration", `${input.sourceCount} sources report this`, Math.min(6, 3 * Math.log2(input.sourceCount)));
  if (input.novelty === "update") add("novelty", "An update of a known development", -3);
  if (input.novelty === "repeat") add("novelty", "A repeat of a known development", -10);
  if (input.feedDepth === "practitioner" && input.depth === "basic") add("depth", "Too basic for this feed", -6);
  const votes =
    Math.min(12, 6 * input.votes.useful) -
    Math.min(12, 6 * input.votes.already_knew) -
    Math.min(16, 8 * input.votes.too_basic) -
    Math.min(20, 10 * input.votes.off_topic);
  add("votes", "Votes of the team", votes);
  const base = Math.max(0, Math.round(parts.reduce((sum, part) => sum + part.value, 0) * 10) / 10);
  return { base, parts };
}

// --- write --------------------------------------------------------------------

const ids = {
  topics: new Map<string, number>(),
  feeds: new Map<FeedKey, number>(),
  sources: new Map<SourceKey, number>(),
};
const sourceDef = (key: SourceKey) => SOURCES.find((source) => source.key === key)!;
const feedDef = (key: FeedKey) => FEEDS.find((feed) => feed.key === key)!;
let usedRealRank = false;

sqlite
  .transaction(() => {
    // Settings (the same keys as the seed of the first run).
    const teamProfile: TeamProfile = {
      whatWeDo: "Software engineering with agentic development: projects for internal teams, and an in-house AI app for the organization.",
      constraints: `${D} Customer data stays in the EU. Each new tool needs a security review.`,
    };
    const feedDefaults = defaultFeedDefaults(timeZone);
    const settingRows: Array<[string, unknown]> = [
      ["team_profile", teamProfile],
      ["brief_defaults", DEFAULT_BRIEF_FORMAT],
      ["default_exclusions", [...DEFAULT_EXCLUSIONS]],
      ["feed_defaults", feedDefaults],
      ["seeded_at", now],
    ];
    for (const [key, value] of settingRows) {
      db.insert(schema.settings).values({ key, value, updatedAt: now - 9 * DAY, updatedBy: "Demo data" }).run();
    }

    // Topics.
    for (const [name, description] of TOPICS) {
      const row = db
        .insert(schema.topics)
        .values({ slug: slug(name), name, description, createdAt: now - 9 * DAY, createdBy: "Demo data" })
        .returning({ id: schema.topics.id })
        .get();
      ids.topics.set(name, row.id);
    }

    // Feeds.
    FEEDS.forEach((feed, index) => {
      const row = db
        .insert(schema.feeds)
        .values({
          slug: slug(feed.name),
          name: feed.name,
          purpose: feed.purpose,
          projectContext: feed.projectContext,
          position: index + 1,
          minRelevance: feedDefaults.minRelevance,
          halfLifeHours: feed.halfLifeHours ?? feedDefaults.halfLifeHours,
          exclusions: [...DEFAULT_EXCLUSIONS],
          relevancePriorities: { ...DEFAULT_RELEVANCE_PRIORITIES, ...feed.priorities },
          briefFormat: { ...EMPTY_BRIEF_FORMAT_OVERRIDE, technicalDepth: feed.technicalDepth ?? null },
          digest: { ...feedDefaults.digest, frequency: "daily" },
          // The quiet hours of the second feed hold now, so that its alert waits.
          quietHours: feed.quietNow
            ? { enabled: true, start: clock(hourNow - 1), end: clock(hourNow + 6) }
            : feedDefaults.quietHours,
          alerts: { enabled: feed.alertsOn, rule: feed.alertRule, minRelevance: feedDefaults.alerts.minRelevance },
          createdAt: now - 9 * DAY,
          createdBy: "Demo data",
          updatedAt: now - 2 * DAY,
        })
        .returning({ id: schema.feeds.id })
        .get();
      ids.feeds.set(feed.key, row.id);
      const priorities: Array<[string[], TopicPriority]> = [
        [feed.high, "high"],
        [feed.low ?? [], "low"],
        [feed.muted ?? [], "muted"],
      ];
      for (const [names, priority] of priorities) {
        for (const name of names) {
          db.insert(schema.feedTopics).values({ feedId: row.id, topicId: ids.topics.get(name)!, priority }).run();
        }
      }
    });

    // Sources, feed links, checks, flags.
    for (const source of SOURCES) {
      const config = parseConfig(source.type, source.config);
      const interval = SOURCE_TYPE_DEFAULTS[source.type].intervalMinutes;
      const checked = source.state !== "waiting";
      const failing = source.state === "failing";
      const lastError = failing ? `${D} The arXiv API returned status 503.` : null;
      const row = db
        .insert(schema.sources)
        .values({
          type: source.type,
          key: sourceKey(source.type, config),
          name: source.name,
          url: source.url,
          config,
          why: source.why,
          addedBy: "Demo data",
          owner: source.owner ?? null,
          paused: source.state === "paused",
          checkIntervalMinutes: interval,
          cursor: checked ? { demo: true } : null,
          nextCheckAt: failing ? now + 8 * HOUR : checked ? now + (interval * 60_000) / 2 : now,
          lastCheckedAt: checked ? now - 25 * 60_000 : null,
          lastSuccessAt: checked ? (failing ? now - 3 * DAY : now - 25 * 60_000) : null,
          lastError,
          consecutiveFailures: failing ? 4 : 0,
          createdAt: now - 8 * DAY,
          updatedAt: now - 1 * DAY,
        })
        .returning({ id: schema.sources.id })
        .get();
      ids.sources.set(source.key, row.id);

      for (const link of source.feeds) {
        db.insert(schema.feedSources)
          .values({
            feedId: ids.feeds.get(link.feed)!,
            sourceId: row.id,
            priority: link.priority,
            follow: link.follow ?? "",
            ignore: link.ignore ?? "",
            addedBy: "Demo data",
            createdAt: now - 8 * DAY,
          })
          .run();
      }

      if (checked) {
        for (let i = 0; i < 6; i += 1) {
          const startedAt = now - 25 * 60_000 - i * interval * 60_000;
          const failed = failing && i < 4;
          db.insert(schema.sourceChecks)
            .values({
              sourceId: row.id,
              startedAt,
              finishedAt: startedAt + 1800 + i * 100,
              ok: !failed,
              itemsFound: failed ? 0 : 6 + i,
              itemsNew: failed ? 0 : i === 0 ? 1 : i % 2,
              error: failed ? lastError : null,
            })
            .run();
        }
      }

      for (const [index, flag] of (source.flags ?? []).entries()) {
        const createdAt = now - (index + 1) * DAY;
        db.insert(schema.sourceFlags)
          .values({
            sourceId: row.id,
            note: flag.note,
            createdBy: flag.by,
            createdAt,
            resolvedAt: flag.resolved ? createdAt + 6 * HOUR : null,
            resolvedBy: flag.resolved ? "Dana" : null,
          })
          .run();
      }
    }

    // Stories, items, judgements, votes.
    let itemNumber = 0;
    const insertItem = (
      source: SourceDef,
      values: Partial<typeof schema.items.$inferInsert> & { title: string; contentText: string; fetchedAt: number },
    ) => {
      itemNumber += 1;
      const url = `https://${new URL(source.url).host}/demo/${source.key}-${itemNumber}`;
      return db
        .insert(schema.items)
        .values({
          sourceId: ids.sources.get(source.key)!,
          externalId: `demo-${source.key}-${itemNumber}`,
          url,
          canonicalUrl: url,
          author: source.kind === "post" ? "demo_investor" : null,
          publishedAt: source.kind === "search_result" ? null : values.fetchedAt - 10 * 60_000,
          kind: source.kind,
          contentHash: `demo-hash-${itemNumber}`,
          meta: source.kind === "search_result" ? { undated: true } : {},
          ...values,
        })
        .returning()
        .get();
    };

    const storyIds: number[] = [];
    const judgementRows: Array<{
      feed: FeedKey;
      storyId: number;
      def: JudgementDef;
      story: StoryDef;
      base: number;
      freshAt: number;
      primaryUrl: string | null;
    }> = [];

    for (const story of STORIES) {
      const freshAt = now - story.ageHours * HOUR;
      const sourceKeys = [...new Set(story.items)];
      const storyRow = db
        .insert(schema.stories)
        .values({
          headline: story.headline,
          summary: story.summary,
          category: story.category,
          entities: story.entities,
          substance: story.substance,
          firstSeenAt: freshAt,
          lastItemAt: freshAt + (story.items.length - 1) * HOUR,
          freshAt,
          itemCount: story.items.length,
          sourceCount: sourceKeys.length,
          createdAt: freshAt + 5 * 60_000,
          updatedAt: freshAt + (story.items.length - 1) * HOUR + 5 * 60_000,
        })
        .returning({ id: schema.stories.id })
        .get();
      storyIds.push(storyRow.id);
      upsertStoryFts(storyRow.id, story.headline, story.summary, story.entities);

      const itemRows = story.items.map((key, index) => {
        const source = sourceDef(key);
        const fetchedAt = freshAt + index * HOUR;
        const meta: Record<string, unknown> =
          source.kind === "episode"
            ? { basis: index === 0 ? (story.basis ?? "show_notes") : "show_notes", durationSeconds: 3900 }
            : source.kind === "search_result"
              ? { undated: true }
              : source.kind === "doc_change"
                ? { before: `${D} The earlier text of the section.`, after: story.summary[0] }
                : {};
        return insertItem(source, {
          title: index === 0 ? story.headline : `${story.headline} (${source.name.replace(`${D} `, "")})`,
          contentText: `${story.summary.join(" ")} ${D} More text of the item from ${source.name.replace(`${D} `, "")}.`,
          fetchedAt,
          meta,
          substance: story.substance,
          storyId: storyRow.id,
          judgeStatus: "judged",
          judgedAt: fetchedAt + 60_000,
        });
      });
      const primary = itemRows[0]!;
      db.update(schema.stories)
        .set({ primaryItemId: primary.id, primaryUrl: primary.url })
        .where(eq(schema.stories.id, storyRow.id))
        .run();
      if (itemRows.length > 1) {
        // The later items link to the first one.
        for (const item of itemRows.slice(1)) {
          db.insert(schema.itemLinks).values({ itemId: item.id, url: primary.canonicalUrl! }).run();
        }
      }

      for (const def of story.judgements) {
        const feed = feedDef(def.feed);
        const feedId = ids.feeds.get(def.feed)!;
        const topicNames = def.topics ?? [];
        const votes = { ...emptyVotes(), ...def.votes };
        const inFeed = sourceKeys.map((key) => sourceDef(key).feeds.find((link) => link.feed === def.feed)).filter(Boolean);
        const sourcePriority: Priority | null = inFeed.some((l) => l!.priority === "high")
          ? "high"
          : inFeed.some((l) => l!.priority === "normal")
            ? "normal"
            : inFeed.length > 0
              ? "low"
              : null;
        const signals: Signals = {
          practical: def.signals?.[0] ?? 1,
          experiment: def.signals?.[2] ?? 1,
        };
        const rankInput: RankInput = {
          relevance: def.relevance,
          exclusion: def.exclusion ?? null,
          substance: story.substance,
          topicPriorities: topicNames.map((name) =>
            feed.high.includes(name) ? "high" : feed.muted?.includes(name) ? "muted" : feed.low?.includes(name) ? "low" : "normal",
          ),
          topicNames,
          signals,
          priorities: { ...DEFAULT_RELEVANCE_PRIORITIES, ...feed.priorities },
          sourcePriority,
          sourceQuality: null,
          sourceCount: sourceKeys.length,
          novelty: def.novelty ?? "new",
          depth: def.depth ?? "intermediate",
          feedDepth: feed.technicalDepth ?? DEFAULT_BRIEF_FORMAT.technicalDepth,
          votes,
          minRelevance: 60,
        };
        const real = realRank(rankInput);
        if (real) usedRealRank = true;
        const rank = real ?? handRank(rankInput);
        const judgedAt = freshAt + 2 * 60_000;

        db.insert(schema.judgements)
          .values({
            feedId,
            storyId: storyRow.id,
            relevance: def.relevance,
            reason: s(
              def.relevance >= 70
                ? `Directly useful for the work of ${feed.name} this week.`
                : def.relevance >= 50
                  ? "Worth knowing. Nothing to do now."
                  : "Only a weak link to the work of this feed.",
            ),
            whyItMatters: s(
              def.relevance >= 70
                ? `It changes a tool or a rule that the ${feed.name} work depends on.`
                : `It gives background for the ${feed.name} work.`,
            ),
            suggestedAction: def.action ?? null,
            topicIds: topicNames.map((name) => ids.topics.get(name)!),
            exclusion: def.exclusion ?? null,
            novelty: rankInput.novelty,
            depth: rankInput.depth,
            signals,
            alert: def.alert ?? false,
            baseScore: rank.base,
            rankParts: rank.parts,
            hiddenReason: def.hidden ?? null,
            sourceItemId: primary.id,
            model: "demo-judge",
            createdAt: judgedAt,
            judgedAt,
            updatedAt: judgedAt,
          })
          .run();
        judgementRows.push({ feed: def.feed, storyId: storyRow.id, def, story, base: rank.base, freshAt, primaryUrl: primary.url });

        let voter = 0;
        for (const reason of Object.keys(votes) as FeedbackReason[]) {
          for (let i = 0; i < votes[reason]; i += 1) {
            voter += 1;
            db.insert(schema.feedback)
              .values({
                feedId,
                storyId: storyRow.id,
                reason,
                clientId: `demo-client-${voter}`,
                createdBy: ["Dana", "Sam", "Priya", "Someone"][(voter - 1) % 4]!,
                createdAt: judgedAt + voter * HOUR,
              })
              .run();
          }
        }
      }
    }

    // Items with no story: they wait for the model, failed, or were skipped.
    const loose: Array<[SourceKey, Partial<typeof schema.items.$inferInsert>, string]> = [
      ["gh", { judgeStatus: "pending" }, "Example Agent 4.1 beta 1"],
      ["docs", { judgeStatus: "pending" }, "Foundry adds a new region for hosted agents"],
      ["pod", { judgeStatus: "pending", meta: { basis: "show_notes", durationSeconds: 4200 } }, "Episode 88: the state of agent tooling"],
      [
        "blog",
        { judgeStatus: "failed", judgeAttempts: 5, judgeError: `${D} The model reply did not fit the schema.` },
        "A post that the model did not judge",
      ],
      ["gh", { judgeStatus: "skipped", skipReason: "first_run_cap" }, "Example Agent 3.8"],
      ["blog", { judgeStatus: "skipped", skipReason: "too_old" }, "An older post from last year"],
      ["news", { judgeStatus: "skipped", skipReason: "no_feed" }, "Issue 41 of the newsletter"],
      ["web", { judgeStatus: "skipped", skipReason: "baseline" }, "A result of the first search run"],
    ];
    loose.forEach(([key, values, title], index) => {
      insertItem(sourceDef(key), {
        title: s(title),
        contentText: s(`The text of the item "${title}".`),
        fetchedAt: now - (index + 1) * 20 * 60_000,
        ...values,
      });
    });

    // Analyses: one done with full content, one queued, one failed.
    const analysisContent: AnalysisContent = {
      whatChanged: [
        s("Example Agent 4.0 moves long tasks to the background. The agent starts the task, continues with other work, and reports when the task finishes."),
        s("The new CI permission mode reads an allow list from the settings file. Commands on the list run with no prompt; all other commands stop the job."),
        s("The settings file has a new format. The release reads the old format and prints a warning. Version 5 removes the old format."),
      ],
      howItWorks: [
        s("A background task runs in its own process with its own log. The `tasks` command lists the tasks and shows the last lines of each log."),
        s("The permission mode matches each command against patterns, for example `npm run test:*`. The release notes do not say how the mode treats pipes."),
      ],
      whatItMeansForUs: [
        s("The dependency-update agent can run its test suites in the background, so one run can cover more repositories."),
        s("The CI permission mode can replace the wrapper script that approves commands in our pipelines."),
      ],
      risksAndLimits: [
        s("The sandbox bug that version 4.0.1 fixed shows that the new shell tool is young. Do not install 4.0.0."),
        s("The sources do not say how background tasks behave when the CI job reaches its time limit."),
      ],
      suggestedActions: [
        {
          action: s("Upgrade the dependency-update agent to 4.0.1 in one repository."),
          why: s("It shows whether background test runs shorten the job."),
          effort: "quick_check",
          firstStep: s("Change the version in the CI image of that repository."),
        },
        {
          action: s("Write the allow list for the CI permission mode."),
          why: s("It replaces the approval wrapper script."),
          effort: "experiment",
          firstStep: s("Collect the commands of the last 20 pipeline runs."),
        },
        {
          action: s("Move the settings files of all repositories to the new format."),
          why: s("Version 5 removes the old format."),
          effort: "project",
          firstStep: s("Count the repositories that have a settings file."),
        },
      ],
      openQuestions: [
        s("Does the permission mode match a command that is part of a pipe?"),
        s("Do background tasks stop when the parent job stops?"),
      ],
      confidence: "medium",
      confidenceNote: s("The analysis uses the release notes and one blog post. No source measured the effect outside the repositories of the maintainers."),
      sourcesUsed: [],
    };
    const firstStory = storyIds[0]!;
    const firstStoryUrls = db
      .select({ url: schema.items.url })
      .from(schema.items)
      .where(eq(schema.items.storyId, firstStory))
      .all()
      .map((row) => row.url!)
      .slice(0, 2);
    db.insert(schema.analyses)
      .values({
        feedId: ids.feeds.get("AD")!,
        storyId: firstStory,
        status: "done",
        stage: null,
        content: { ...analysisContent, sourcesUsed: firstStoryUrls },
        model: "demo-analysis",
        attempts: 1,
        requestedBy: "Dana",
        requestedAt: now - 6 * HOUR,
        startedAt: now - 6 * HOUR + 4000,
        updatedAt: now - 6 * HOUR + 42_000,
        finishedAt: now - 6 * HOUR + 42_000,
      })
      .run();
    db.insert(schema.analyses)
      .values({
        feedId: ids.feeds.get("AD")!,
        storyId: storyIds[3]!,
        status: "queued",
        requestedBy: "Sam",
        requestedAt: now - 40_000,
        updatedAt: now - 40_000,
      })
      .run();
    db.insert(schema.analyses)
      .values({
        feedId: ids.feeds.get("IP")!,
        storyId: storyIds[14]!,
        status: "failed",
        error: `${D} The model reply did not fit the schema after 3 attempts.`,
        model: "demo-analysis",
        attempts: 3,
        requestedBy: "Priya",
        requestedAt: now - 3 * HOUR,
        startedAt: now - 3 * HOUR + 3000,
        updatedAt: now - 3 * HOUR + 190_000,
        finishedAt: now - 3 * HOUR + 190_000,
      })
      .run();

    // Digests: two with entries for the first feed, one with zero entries for the third feed.
    const digestEntries = (feed: FeedKey, from: number, to: number): DigestEntry[] =>
      judgementRows
        .filter((row) => row.feed === feed && !row.def.hidden && row.freshAt >= from && row.freshAt < to)
        .sort((a, b) => b.base - a.base)
        .slice(0, 10)
        .map((row) => ({
          storyId: row.storyId,
          headline: row.story.headline,
          summary: row.story.summary,
          whyItMatters: s(`It changes a tool or a rule that the ${feedDef(feed).name} work depends on.`),
          suggestedAction: row.def.action ?? null,
          relevance: row.def.relevance,
          baseScore: row.base,
          primaryUrl: row.primaryUrl,
          category: row.story.category,
          freshAt: row.freshAt,
        }));
    const dateText = (instant: number) =>
      new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(instant);
    const digestRows: Array<[FeedKey, number, number]> = [
      ["AD", now - 3 * DAY - 2 * HOUR, now - 1 * DAY - 2 * HOUR],
      ["AD", now - 1 * DAY - 2 * HOUR, now - 2 * HOUR],
      ["IR", now - 1 * DAY - 2 * HOUR, now - 2 * HOUR],
    ];
    digestRows.forEach(([feed, start, end], index) => {
      db.insert(schema.digests)
        .values({
          feedId: ids.feeds.get(feed)!,
          periodStart: start,
          periodEnd: end,
          title: `${feedDef(feed).name} — daily digest — ${dateText(end)}`,
          // The third digest has zero entries: the list does not show it.
          entries: index === 2 ? [] : digestEntries(feed, start, end),
          createdAt: end + 30_000,
        })
        .run();
    });

    // Alerts: one that shows now, one that waits for the end of the quiet hours.
    db.insert(schema.alerts)
      .values({ feedId: ids.feeds.get("AD")!, storyId: storyIds[1]!, createdAt: now - 3 * HOUR + 120_000, visibleAt: now - 3 * HOUR + 120_000 })
      .run();
    db.insert(schema.alerts)
      .values({ feedId: ids.feeds.get("IP")!, storyId: storyIds[13]!, createdAt: now - 50 * 60_000, visibleAt: now + 5 * HOUR })
      .run();

    // One re-judge request in progress.
    db.insert(schema.rejudgeRequests)
      .values({
        feedId: ids.feeds.get("IP")!,
        sourceId: null,
        sinceAt: now - 7 * DAY,
        status: "running",
        total: 12,
        done: 5,
        failed: 0,
        requestedBy: "Dana",
        requestedAt: now - 90_000,
        startedAt: now - 80_000,
        updatedAt: now - 5000,
      })
      .run();

    // Usage counters: today and yesterday (UTC).
    const day = (instant: number) => new Date(instant).toISOString().slice(0, 10);
    const usageRows: Array<[string, (typeof schema.usageDaily.$inferInsert)["metric"], number]> = [
      [day(now), "llm_calls", 212],
      [day(now), "llm_calls_preview", 6],
      [day(now), "llm_input_tokens", 486_300],
      [day(now), "llm_output_tokens", 61_250],
      [day(now), "x_posts", 0],
      [day(now), "web_searches", 3],
      [day(now - DAY), "llm_calls", 341],
      [day(now - DAY), "llm_input_tokens", 790_400],
      [day(now - DAY), "llm_output_tokens", 98_700],
      [day(now - DAY), "web_searches", 4],
    ];
    for (const [dayText, metric, value] of usageRows) {
      db.insert(schema.usageDaily).values({ day: dayText, metric, value }).run();
    }

    // Events.
    const eventRows: Array<[number, "info" | "warn" | "error", string, string, Record<string, unknown> | null]> = [
      [50, "info", "worker", s("The worker started."), null],
      [47, "info", "pipeline", s("Source check done: 7 items, 1 new."), { sourceId: ids.sources.get("gh") }],
      [44, "warn", "pipeline", s("The source check failed: the arXiv API returned status 503."), { sourceId: ids.sources.get("arxiv") }],
      [40, "warn", "llm", s("The model was overloaded. Judging starts again in 2 minutes."), null],
      [36, "info", "pipeline", s("Judged 12 items."), null],
      [30, "error", "llm", s("The model reply did not fit the schema after the repair retry."), { itemTitle: "A post that the model did not judge" }],
      [26, "warn", "pipeline", s("The source check failed: the arXiv API returned status 503."), { sourceId: ids.sources.get("arxiv") }],
      [20, "warn", "fts", s("The story search failed."), null],
      [14, "info", "digests", s("Created 2 digests."), null],
      [9, "error", "analysis", s("The analysis failed after 3 attempts."), { storyId: storyIds[14] }],
      [5, "warn", "pipeline", s("X sources wait: X_BEARER_TOKEN is missing."), null],
      [1, "info", "rejudge", s("Re-judge started for Internal AI Platform: 12 stories."), null],
    ];
    for (const [minutesAgo, level, scope, message, data] of eventRows) {
      db.insert(schema.events).values({ at: now - minutesAgo * 60_000, level, scope, message, data }).run();
    }

    // Activity log.
    const activityRows: Array<[number, string, string, string, number | null, string]> = [
      [8 * DAY, "Demo data", "source.create", "source", ids.sources.get("gh")!, s('Added the source "Example Agent releases".')],
      [8 * DAY - HOUR, "Demo data", "source.create", "source", ids.sources.get("docs")!, s(`Added the source "Foundry: What's new".`)],
      [6 * DAY, "Dana", "feed.source.update", "feed", ids.feeds.get("IP")!, s("Internal AI Platform: Follow text of the Foundry source changed.")],
      [5 * DAY, "Sam", "topic.create", "topic", ids.topics.get("Document processing")!, s('Added the topic "Document processing".')],
      [4 * DAY, "Priya", "source.flag", "source", ids.sources.get("hn")!, s("Flagged the Hacker News source as noisy.")],
      [3 * DAY, "Dana", "feed.interests.update", "feed", ids.feeds.get("AD")!, s('Agentic Development: topic "Company announcements" is now muted.')],
      [2 * DAY, "Sam", "source.pause", "source", ids.sources.get("yt")!, s('Paused the source "Agent Talks channel".')],
      [2 * DAY - HOUR, "Dana", "settings.team_profile.update", "settings", null, s("Changed the shared feed profile: requirements.")],
      [1 * DAY, "Priya", "feed.delivery.update", "feed", ids.feeds.get("IP")!, s("Internal AI Platform: alerts are on; quiet hours changed.")],
      [6 * HOUR, "Dana", "analysis.request", "story", storyIds[0]!, s("Asked for the deeper analysis of a story.")],
      [3 * HOUR, "Sam", "source.flag", "source", ids.sources.get("hn")!, s("Flagged the Hacker News source as noisy.")],
      [90_000, "Dana", "rejudge.request", "feed", ids.feeds.get("IP")!, s("Internal AI Platform: re-judge of the last 7 days (12 stories).")],
    ];
    for (const [ago, actor, action, entityType, entityId, summary] of activityRows) {
      db.insert(schema.activity).values({ at: now - ago, actor, action, entityType, entityId, summary }).run();
    }

    // Worker state: a fresh heartbeat. No lease, so that a real worker can start.
    const heartbeat: WorkerHeartbeat = { at: now, hasModelKey: true, hasXToken: false, hasMailbox: false };
    db.insert(schema.workerState).values({ key: "heartbeat", value: heartbeat, updatedAt: now }).run();
    db.insert(schema.workerState).values({ key: "llm_pause_step", value: 0, updatedAt: now - 40 * 60_000 }).run();
  })
  .immediate();

// --- report -------------------------------------------------------------------

const tables = [
  "settings",
  "topics",
  "feeds",
  "feed_topics",
  "sources",
  "source_checks",
  "source_flags",
  "feed_sources",
  "items",
  "item_links",
  "stories",
  "stories_fts",
  "judgements",
  "feedback",
  "analyses",
  "digests",
  "alerts",
  "rejudge_requests",
  "usage_daily",
  "events",
  "activity",
  "worker_state",
];
console.log(`demo-data: wrote ${file}`);
console.log(`demo-data: rank values from ${usedRealRank ? "src/lib/ranking (baseScore)" : "the approximation in this script (the ranking is a stub)"}`);
for (const table of tables) {
  const n = sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  console.log(`${table.padEnd(18)} ${n}`);
}
closeDb();
