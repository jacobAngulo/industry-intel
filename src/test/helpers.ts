// Test helpers and fakes. No test makes a network call and no test needs a
// real key.
//
//   const t = installTestDb();          // getDb() / getSqlite() now use a temporary database
//   afterEach(() => t.cleanup());
//
// This file imports nothing from vitest, so a script can also use the
// factories.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig, sourceKey } from "@/lib/connectors/configs";
import type { ConnectorContext, UsageMeter } from "@/lib/connectors/types";
import { createTestDb, getDb, setDbHandleForTests, type Db, type Sqlite } from "@/lib/db/client";
import { upsertStoryFts } from "@/lib/db/fts";
import {
  feedback,
  feedSources,
  feeds,
  itemLinks,
  items,
  judgements,
  sources,
  stories,
  topics,
  users,
  type FeedbackDbRow,
  type FeedDbRow,
  type FeedSourceDbRow,
  type ItemDbRow,
  type JudgementDbRow,
  type NewFeedDbRow,
  type NewItemDbRow,
  type NewJudgementDbRow,
  type NewSourceDbRow,
  type NewStoryDbRow,
  type SourceDbRow,
  type StoryDbRow,
  type TopicDbRow,
} from "@/lib/db/schema";
import { createEnv, type Env, type EnvName } from "@/lib/env";
import { HttpError, type HttpRequest, type HttpResponse, type SafeHttp } from "@/lib/http/types";
import { nowMs, setNowForTests } from "@/lib/time";
import {
  DEFAULT_RELEVANCE_PRIORITIES,
  EMPTY_BRIEF_FORMAT_OVERRIDE,
  SOURCE_TYPE_DEFAULTS,
  defaultFeedDefaults,
  type FeedbackReason,
  type Priority,
  type SourceType,
  type UsageMetric,
} from "@/lib/types";

export { setNowForTests } from "@/lib/time";
export { FakeLlm } from "@/lib/llm/fake";
export { createEnv } from "@/lib/env";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export interface InstalledTestDb {
  db: Db;
  sqlite: Sqlite;
  /** The path of the temporary SQLite file. */
  file: string;
  /** Removes the handle, closes the database, deletes the temporary folder, and gives the real clock back. */
  cleanup: () => void;
}

/**
 * Opens a temporary, migrated database (not seeded unless `seed: true`) and
 * makes getDb() and getSqlite() return it. Call `cleanup()` after the test.
 */
export function installTestDb(options: { seed?: boolean } = {}): InstalledTestDb {
  const test = createTestDb(options);
  setDbHandleForTests({ db: test.db, sqlite: test.sqlite, file: test.file });
  return {
    db: test.db,
    sqlite: test.sqlite,
    file: test.file,
    cleanup: () => {
      setDbHandleForTests(null);
      setNowForTests(null);
      test.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THIS_FILE_SUFFIX = `${path.sep}src${path.sep}test${path.sep}helpers.ts`;

/** The folder of the first file on the call stack that is not this file. */
function callerDir(): string {
  const original = Error.prepareStackTrace;
  let sites: NodeJS.CallSite[] = [];
  try {
    Error.prepareStackTrace = (_error, callSites) => callSites;
    sites = new Error().stack as unknown as NodeJS.CallSite[];
  } finally {
    Error.prepareStackTrace = original;
  }
  for (const site of Array.isArray(sites) ? sites : []) {
    const name = site.getFileName();
    if (!name || name.startsWith("node:")) continue;
    const file = name.startsWith("file://") ? fileURLToPath(name) : name;
    if (file.endsWith(THIS_FILE_SUFFIX) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return path.dirname(file);
  }
  throw new Error("loadFixture: the calling file was not found. Give an absolute path, or the folder as `from`.");
}

/**
 * Reads a fixture file as text.
 * - An absolute path is read as it is.
 * - A relative path starts at the `__fixtures__` folder next to the calling
 *   test file (then at the folder of the calling file).
 * - `from` (a folder, a file path, or `import.meta.url`) replaces the search
 *   for the calling file.
 */
export function loadFixture(fixturePath: string, from?: string): string {
  if (path.isAbsolute(fixturePath)) return fs.readFileSync(fixturePath, "utf8");

  let dir: string;
  if (from) {
    const file = from.startsWith("file://") ? fileURLToPath(from) : from;
    dir = fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file);
  } else {
    dir = callerDir();
  }
  const candidates = [path.join(dir, "__fixtures__", fixturePath), path.join(dir, fixturePath)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  throw new Error(`loadFixture: no file "${fixturePath}" in ${path.join(dir, "__fixtures__")}`);
}

/** loadFixture + JSON.parse. */
export function loadJsonFixture<T = unknown>(fixturePath: string, from?: string): T {
  // The caller of this function is the file to search from.
  return JSON.parse(loadFixture(fixturePath, from ?? callerDir())) as T;
}

// ---------------------------------------------------------------------------
// FakeHttp
// ---------------------------------------------------------------------------

export interface FakeHttpReply {
  /** Default 200. */
  status?: number;
  /** Any case; the response has lower-case names. */
  headers?: Record<string, string>;
  text?: string;
  /** Sets the text to JSON and the content type to application/json. */
  json?: unknown;
  /** With an etag, a request that sends the same etag gets 304 (conditional GET). */
  etag?: string;
  /** With lastModified, a request that sends the same value gets 304 (conditional GET). */
  lastModified?: string;
  /** The final URL after redirects. Default: the request URL. */
  url?: string;
  /** Throw this error instead of a response (for example new HttpError("timeout", "…")). */
  error?: Error;
}

export type FakeHttpResponder = FakeHttpReply | ((req: HttpRequest) => FakeHttpReply | Promise<FakeHttpReply>);
export type FakeHttpMatcher = string | RegExp | ((req: HttpRequest) => boolean);

type Route = {
  kind: "exact" | "prefix" | "predicate";
  test: (req: HttpRequest) => boolean;
  responder: FakeHttpResponder;
};

/**
 * A SafeHttp for tests. It routes by exact URL, by prefix, or by a predicate.
 * An exact route wins over the other routes; then the first route that was
 * added wins. A URL with no route gets status 404. It keeps a request log.
 *
 *   const http = new FakeHttp()
 *     .on("https://example.com/feed.xml", { text: xml, etag: '"v1"' })
 *     .onPrefix("https://api.example.com/", (req) => ({ json: { url: req.url } }));
 */
export class FakeHttp implements SafeHttp {
  /** The request log, oldest first. */
  readonly requests: HttpRequest[] = [];
  #routes: Route[] = [];

  /** An exact URL (string), a pattern (RegExp), or a predicate. */
  on(matcher: FakeHttpMatcher, responder: FakeHttpResponder): this {
    if (typeof matcher === "string") {
      this.#routes.push({ kind: "exact", test: (req) => req.url === matcher, responder });
    } else if (matcher instanceof RegExp) {
      this.#routes.push({ kind: "predicate", test: (req) => new RegExp(matcher.source, matcher.flags.replace("g", "")).test(req.url), responder });
    } else {
      this.#routes.push({ kind: "predicate", test: matcher, responder });
    }
    return this;
  }

  /** Each URL that starts with the prefix. */
  onPrefix(prefix: string, responder: FakeHttpResponder): this {
    this.#routes.push({ kind: "prefix", test: (req) => req.url.startsWith(prefix), responder });
    return this;
  }

  /** Removes all routes and empties the request log. */
  reset(): this {
    this.#routes = [];
    this.requests.length = 0;
    return this;
  }

  /** The URLs of the request log, oldest first. */
  get urls(): string[] {
    return this.requests.map((req) => req.url);
  }

  /** The number of requests whose URL is equal to (string) or matches (RegExp) the argument. */
  count(matcher: string | RegExp): number {
    return this.requests.filter((req) => (typeof matcher === "string" ? req.url === matcher : matcher.test(req.url)))
      .length;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push({ ...req });
    if (req.signal?.aborted) throw new HttpError("timeout", "The request was stopped.");

    const route =
      this.#routes.find((candidate) => candidate.kind === "exact" && candidate.test(req)) ??
      this.#routes.find((candidate) => candidate.kind !== "exact" && candidate.test(req));
    if (!route) {
      return { status: 404, ok: false, url: req.url, headers: {}, text: "Not found (FakeHttp has no route)", notModified: false };
    }

    const reply = typeof route.responder === "function" ? await route.responder(req) : route.responder;
    if (reply.error) throw reply.error;

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(reply.headers ?? {})) headers[name.toLowerCase()] = value;
    const etag = reply.etag ?? headers.etag;
    const lastModified = reply.lastModified ?? headers["last-modified"];
    if (etag !== undefined) headers.etag = etag;
    if (lastModified !== undefined) headers["last-modified"] = lastModified;

    const method = req.method ?? "GET";
    const sameEtag = etag !== undefined && req.etag !== undefined && req.etag === etag;
    const sameDate = lastModified !== undefined && req.lastModified !== undefined && req.lastModified === lastModified;
    if (method === "GET" && reply.status === undefined && (sameEtag || (req.etag === undefined && sameDate))) {
      return {
        status: 304,
        ok: false,
        url: reply.url ?? req.url,
        headers,
        text: "",
        notModified: true,
        ...(etag !== undefined ? { etag } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
      };
    }

    let text = reply.text ?? "";
    if (reply.json !== undefined) {
      text = JSON.stringify(reply.json);
      headers["content-type"] ??= "application/json";
    }
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      url: reply.url ?? req.url,
      headers,
      text: status === 304 ? "" : text,
      notModified: status === 304,
      ...(etag !== undefined ? { etag } : {}),
      ...(lastModified !== undefined ? { lastModified } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Fake usage meter and connector context
// ---------------------------------------------------------------------------

/** A UsageMeter in memory. A metric with no limit in `limits` has no limit. */
export class FakeUsageMeter implements UsageMeter {
  readonly counts: Partial<Record<UsageMetric, number>> = {};
  limits: Partial<Record<UsageMetric, number>>;

  constructor(limits: Partial<Record<UsageMetric, number>> = {}) {
    this.limits = { ...limits };
  }

  take(metric: UsageMetric, n: number): boolean {
    const limit = this.limits[metric] ?? Infinity;
    if (this.today(metric) + n > limit) return false;
    this.add(metric, n);
    return true;
  }

  add(metric: UsageMetric, n: number): void {
    this.counts[metric] = this.today(metric) + n;
  }

  remaining(metric: UsageMetric): number {
    const limit = this.limits[metric];
    return limit === undefined ? Infinity : Math.max(0, limit - this.today(metric));
  }

  today(metric: UsageMetric): number {
    return this.counts[metric] ?? 0;
  }
}

/** An Env over the given values only (it does not read process.env). */
export function makeEnv(values: Partial<Record<EnvName, string>> = {}): Env {
  return createEnv(values);
}

export type TestConnectorContext = ConnectorContext & { http: SafeHttp };

/**
 * A ConnectorContext for connector tests. Defaults: a new FakeHttp, an empty
 * environment, the clock of nowMs(), a FakeUsageMeter with no limit, no
 * search provider, no mailbox.
 */
export function makeConnectorContext(overrides: Partial<ConnectorContext> = {}): TestConnectorContext {
  return {
    http: new FakeHttp(),
    env: makeEnv(),
    now: nowMs,
    usage: new FakeUsageMeter(),
    search: null,
    mail: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Row factories (they write to the database of getDb())
// ---------------------------------------------------------------------------

let sequence = 0;
const next = () => (sequence += 1);

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

export function makeTopic(overrides: Partial<typeof topics.$inferInsert> = {}): TopicDbRow {
  const n = next();
  const name = overrides.name ?? `Topic ${n}`;
  return getDb()
    .insert(topics)
    .values({
      slug: `${slugOf(name)}-${n}`,
      name,
      description: `About ${name}.`,
      createdAt: nowMs(),
      createdBy: "Test",
      ...overrides,
    })
    .returning()
    .get();
}

export function makeFeed(overrides: Partial<NewFeedDbRow> = {}): FeedDbRow {
  const n = next();
  const name = overrides.name ?? `Feed ${n}`;
  const defaults = defaultFeedDefaults("UTC");
  const now = nowMs();
  return getDb()
    .insert(feeds)
    .values({
      slug: `${slugOf(name)}-${n}`,
      name,
      purpose: `The purpose of ${name}.`,
      projectContext: "",
      position: n,
      minRelevance: defaults.minRelevance,
      halfLifeHours: defaults.halfLifeHours,
      exclusions: [],
      relevancePriorities: { ...DEFAULT_RELEVANCE_PRIORITIES },
      briefFormat: { ...EMPTY_BRIEF_FORMAT_OVERRIDE },
      digest: defaults.digest,
      quietHours: defaults.quietHours,
      alerts: defaults.alerts,
      createdAt: now,
      createdBy: "Test",
      updatedAt: now,
      ...overrides,
    })
    .returning()
    .get();
}

function defaultConfig(type: SourceType, n: number): unknown {
  switch (type) {
    case "x_user":
      return { username: `user${n}` };
    case "x_search":
      return { query: `keyword ${n}` };
    case "podcast":
      return { feedUrl: `https://example.com/podcast-${n}.xml`, show: `Show ${n}` };
    case "blog":
      return { feedUrl: `https://example.com/feed-${n}.xml` };
    case "github":
      return { owner: "example", repo: `repo-${n}` };
    case "docs":
      return { url: `https://example.com/docs/changelog-${n}` };
    case "newsletter":
      return { variant: "feed", feedUrl: `https://example.com/newsletter-${n}.xml` };
    case "youtube":
      return { variant: "channel", channelId: `UC${String(n).padStart(22, "0")}`, title: `Channel ${n}` };
    case "community":
      return { variant: "hn", query: `topic ${n}` };
    case "research":
      return { variant: "arxiv_query", query: `subject ${n}` };
    case "web_search":
      return { query: `search ${n}` };
  }
}

/**
 * Inserts a source. Default type: `blog`. The config gets the schema
 * defaults and the key comes from sourceKey, unless the override gives a
 * `key` (then the config is stored as given).
 */
export function makeSource(overrides: Partial<NewSourceDbRow> = {}): SourceDbRow {
  const n = next();
  const type = overrides.type ?? "blog";
  let config = overrides.config ?? defaultConfig(type, n);
  let key = overrides.key;
  if (key === undefined) {
    const parsed = parseConfig(type, config);
    config = parsed;
    key = sourceKey(type, parsed);
  }
  const now = nowMs();
  return getDb()
    .insert(sources)
    .values({
      name: `Source ${n}`,
      why: "A test source.",
      addedBy: "Test",
      checkIntervalMinutes: SOURCE_TYPE_DEFAULTS[type].intervalMinutes,
      nextCheckAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
      type,
      key,
      config,
    })
    .returning()
    .get();
}

export function linkFeedSource(
  feedId: number,
  sourceId: number,
  overrides: { priority?: Priority; follow?: string; ignore?: string; addedBy?: string; createdAt?: number } = {},
): FeedSourceDbRow {
  return getDb()
    .insert(feedSources)
    .values({ feedId, sourceId, priority: "normal", follow: "", ignore: "", addedBy: "Test", createdAt: nowMs(), ...overrides })
    .returning()
    .get();
}

/**
 * Inserts an item. `sourceId` is required. `links` become item_links rows.
 * Defaults: kind `article`, a URL (also the canonical URL), status `pending`
 * (`judged` when a `storyId` is given).
 */
export function makeItem(
  input: Partial<NewItemDbRow> & { sourceId: number; links?: string[] },
): ItemDbRow {
  const { links, ...overrides } = input;
  const n = next();
  const now = nowMs();
  const url = overrides.url === undefined ? `https://example.com/post-${n}` : overrides.url;
  const hasStory = overrides.storyId !== undefined && overrides.storyId !== null;
  const row = getDb()
    .insert(items)
    .values({
      externalId: `item-${n}`,
      url,
      canonicalUrl: url,
      title: `Item ${n}`,
      author: null,
      publishedAt: now,
      fetchedAt: now,
      kind: "article",
      contentText: `The text of item ${n}.`,
      contentHash: `hash-${n}`,
      meta: {},
      judgeStatus: hasStory ? "judged" : "pending",
      judgedAt: hasStory ? now : null,
      ...overrides,
    })
    .returning()
    .get();
  if (links && links.length > 0) {
    getDb()
      .insert(itemLinks)
      .values([...new Set(links)].map((link) => ({ itemId: row.id, url: link })))
      .run();
  }
  return row;
}

/** Inserts a story and its row in stories_fts. */
export function makeStory(overrides: Partial<NewStoryDbRow> = {}): StoryDbRow {
  const n = next();
  const now = nowMs();
  const row = getDb()
    .insert(stories)
    .values({
      headline: `Story ${n}`,
      summary: [`The first fact of story ${n}.`, `The second fact of story ${n}.`],
      category: "release",
      entities: [],
      substance: "news",
      firstSeenAt: now,
      lastItemAt: now,
      freshAt: now,
      itemCount: 1,
      sourceCount: 1,
      primaryItemId: null,
      primaryUrl: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .returning()
    .get();
  upsertStoryFts(row.id, row.headline, row.summary, row.entities);
  return row;
}

/**
 * Inserts a judgement. `feedId` and `storyId` are required. Defaults:
 * relevance 75, visible, base score = relevance, one rank part.
 */
export function makeJudgement(
  input: Partial<NewJudgementDbRow> & { feedId: number; storyId: number },
): JudgementDbRow {
  const now = nowMs();
  const relevance = input.relevance ?? 75;
  return getDb()
    .insert(judgements)
    .values({
      relevance,
      reason: "Directly useful for the work of this feed.",
      whyItMatters: "It changes a tool that the team uses.",
      suggestedAction: null,
      topicIds: [],
      exclusion: null,
      novelty: "new",
      depth: "intermediate",
      signals: { practical: 2, experiment: 1 },
      alert: false,
      baseScore: relevance,
      rankParts: [{ key: "relevance", label: "Relevance", value: relevance }],
      hiddenReason: null,
      sourceItemId: null,
      model: "fake-judge",
      createdAt: now,
      judgedAt: now,
      updatedAt: now,
      ...input,
    })
    .returning()
    .get();
}

/** Inserts an account (no access) if it is not there, and returns its id. */
export function makeUser(id = `user-${next()}`, name = id): string {
  const now = nowMs();
  getDb()
    .insert(users)
    .values({ id, email: `${id}@example.com`, name, createdAt: now, lastSignInAt: now })
    .onConflictDoNothing()
    .run();
  return id;
}

/** Inserts one feedback vote. Each call uses a new account unless one is given. */
export function addVote(input: {
  feedId: number;
  storyId: number;
  reason: FeedbackReason;
  userId?: string;
  createdAt?: number;
}): FeedbackDbRow {
  return getDb()
    .insert(feedback)
    .values({
      feedId: input.feedId,
      storyId: input.storyId,
      reason: input.reason,
      userId: makeUser(input.userId),
      createdAt: input.createdAt ?? nowMs(),
    })
    .returning()
    .get();
}
