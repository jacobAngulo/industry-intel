import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { FakeHttp, loadFixture, makeConnectorContext, makeEnv } from "@/test/helpers";

import { githubConfigSchema, type GithubConfig } from "../configs";
import { ConnectorError } from "../types";
import { connector, isPrereleaseTag, parseRepoInput, type GithubCursor } from "./index";

const CC_FEED = "https://github.com/anthropics/claude-code/releases.atom";
const CODEX_FEED = "https://github.com/openai/codex/releases.atom";
const MCP_FEED = "https://github.com/modelcontextprotocol/modelcontextprotocol/releases.atom";
const CC_ADVISORIES =
  "https://api.github.com/repos/anthropics/claude-code/security-advisories?per_page=30&sort=published&direction=desc";
const GRAPHQL = "https://api.github.com/graphql";
const NOW = Date.parse("2026-11-20T12:00:00Z");

const ccAtom = loadFixture("releases-claude-code.atom");
const codexAtom = loadFixture("releases-codex.atom");
const mcpAtom = loadFixture("releases-mcp.atom");
const advisoriesJson = loadFixture("advisories-claude-code.json");

function config(values: Partial<GithubConfig> & { owner: string; repo: string }): GithubConfig {
  return githubConfigSchema.parse(values);
}

function ctxWith(http: FakeHttp, env: Record<string, string> = {}) {
  return makeConnectorContext({ http, env: makeEnv(env), now: () => NOW });
}

async function expectConnectorError(promise: Promise<unknown>, kind: ConnectorError["kind"], pattern?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).kind).toBe(kind);
  if (pattern) expect((error as ConnectorError).message).toMatch(pattern);
  return error as ConnectorError;
}

describe("isPrereleaseTag", () => {
  it.each([
    ["rust-v0.173.0-alpha.1", true],
    ["0.171.0-alpha.13.1", true],
    ["v1.2.0-rc1", true],
    ["v2.0.0-beta", true],
    ["2025-11-25-RC", true],
    ["nightly-2026-11-20", true],
    ["v3.0.0-canary.4", true],
    ["v1.0.0-preview", true],
    ["1.4.0-2", true],
    ["2.0.0b1", true],
    ["v5-dev", true],
    ["pre-release-7", true],
    ["v2.1.329", false],
    ["rust-v0.171.0", false],
    ["2025-11-25", false],
    ["2024-11-05-final", false],
    ["devtools-v1.2.0", false],
    ["release-candidate-free", false],
    ["", false],
  ])("%s -> %s", (tag, expected) => {
    expect(isPrereleaseTag(tag)).toBe(expected);
  });
});

describe("parseRepoInput", () => {
  it.each([
    ["https://github.com/anthropics/claude-code", "anthropics", "claude-code", null, true],
    ["https://github.com/anthropics/claude-code/", "anthropics", "claude-code", null, true],
    ["http://www.github.com/openai/codex.git", "openai", "codex", null, true],
    ["github.com/openai/codex/releases", "openai", "codex", "releases", true],
    ["https://github.com/openai/codex/releases/tag/rust-v0.171.0", "openai", "codex", "releases", true],
    ["https://github.com/modelcontextprotocol/modelcontextprotocol/discussions", "modelcontextprotocol", "modelcontextprotocol", "discussions", true],
    ["https://github.com/openai/codex/issues/123", "openai", "codex", null, true],
    ["https://github.com/anthropics/claude-code/security/advisories", "anthropics", "claude-code", "advisories", true],
    ["https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#v2", "anthropics", "claude-code", null, true],
    ["https://github.com/anthropics/claude-code?tab=readme", "anthropics", "claude-code", null, true],
    ["git@github.com:openai/codex.git", "openai", "codex", null, true],
    ["https://api.github.com/repos/openai/codex", "openai", "codex", null, true],
    ["anthropics/claude-code", "anthropics", "claude-code", null, false],
    ["  openai/codex.git ", "openai", "codex", null, false],
  ])("%s", (input, owner, repo, focus, fromLink) => {
    expect(parseRepoInput(input)).toEqual({ owner, repo, focus, fromLink });
  });

  it.each([
    "https://github.com/anthropics",
    "https://github.com/settings/profile",
    "https://github.com/orgs/anthropics/repositories",
    "https://gitlab.com/a/b",
    "https://example.com/a/b",
    "claude code",
    "a/b/c",
    "-bad/repo",
    "owner/..",
    "",
    "cursor.com/changelog",
  ])("not a repository: %s", (input) => {
    expect(parseRepoInput(input)).toBeNull();
  });
});

describe("resolve", () => {
  it("a repository link: one request to the releases feed; exact name and the latest release", async () => {
    const http = new FakeHttp().on(CC_FEED, { text: ccAtom });
    const found = await connector.resolve("https://github.com/anthropics/claude-code/releases", ctxWith(http), false);
    expect(http.urls).toEqual([CC_FEED]);
    expect(found).toHaveLength(1);
    const c = found[0]!;
    expect(c.type).toBe("github");
    expect(c.name).toBe("anthropics/claude-code");
    expect(c.url).toBe("https://github.com/anthropics/claude-code");
    expect(c.confidence).toBeCloseTo(0.95);
    expect(c.description).toMatch(/^GitHub repository\. Latest release: v2\.1\.329 \(19 Nov 2026\)\.$/);
    expect(c.config).toEqual(config({ owner: "anthropics", repo: "claude-code" }));
    expect(githubConfigSchema.safeParse(c.config).success).toBe(true);
    expect(c.warnings).toEqual(["Discussions need GITHUB_TOKEN"]);
  });

  it("takes the exact name from the feed when the person typed another case", async () => {
    const http = new FakeHttp().on("https://github.com/Anthropics/Claude-Code/releases.atom", { text: ccAtom });
    const [c] = await connector.resolve("Anthropics/Claude-Code", ctxWith(http), false);
    expect(c?.name).toBe("anthropics/claude-code");
    expect(c?.confidence).toBeCloseTo(0.7);
    expect(connector.keyOf(c!.config as GithubConfig)).toBe("github:anthropics/claude-code");
  });

  it("a link to discussions switches discussions on; with a token there is no warning", async () => {
    const http = new FakeHttp().on(MCP_FEED, { text: mcpAtom });
    const [c] = await connector.resolve(
      "https://github.com/modelcontextprotocol/modelcontextprotocol/discussions",
      ctxWith(http, { GITHUB_TOKEN: "test-token" }),
      false,
    );
    expect(c?.config).toMatchObject({ discussions: true, advisories: false, releases: true });
    expect(c?.warnings).toBeUndefined();
    expect(c?.description).toMatch(/Latest release: 2026-07-28 \(28 Jul 2026\)/);
  });

  it("a link to security advisories switches advisories on", async () => {
    const http = new FakeHttp().on(CC_FEED, { text: ccAtom });
    const [c] = await connector.resolve("https://github.com/anthropics/claude-code/security/advisories", ctxWith(http), false);
    expect(c?.config).toMatchObject({ advisories: true });
  });

  it("follows a redirect of a renamed repository", async () => {
    const http = new FakeHttp().on("https://github.com/old-owner/old-name/releases.atom", {
      text: codexAtom,
      url: "https://github.com/openai/codex/releases.atom",
    });
    const [c] = await connector.resolve("old-owner/old-name", ctxWith(http), true);
    expect(c?.name).toBe("openai/codex");
    expect(c?.confidence).toBeCloseTo(0.85);
  });

  it("a repository with no releases", async () => {
    const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from x</title>' +
      '<link type="text/html" rel="alternate" href="https://github.com/acme/tool/releases"/></feed>';
    const http = new FakeHttp().on("https://github.com/acme/tool/releases.atom", { text: empty });
    const [c] = await connector.resolve("https://github.com/acme/tool", ctxWith(http), false);
    expect(c?.description).toBe("GitHub repository. No releases yet.");
  });

  it("a missing repository gives no candidate", async () => {
    const http = new FakeHttp().on("https://github.com/anthropics/no-such-repo/releases.atom", { status: 404, text: "Not Found" });
    expect(await connector.resolve("https://github.com/anthropics/no-such-repo", ctxWith(http), false)).toEqual([]);
  });

  it("GitHub does not answer: a lower candidate with a warning", async () => {
    const http = new FakeHttp().on(CC_FEED, { error: new HttpError("timeout", "timeout") });
    const [c] = await connector.resolve("https://github.com/anthropics/claude-code", ctxWith(http), false);
    expect(c?.confidence).toBeCloseTo(0.6);
    expect(c?.warnings?.[0]).toMatch(/could not check/);
    const http2 = new FakeHttp().on(CC_FEED, { status: 503, text: "busy" });
    const [d] = await connector.resolve("anthropics/claude-code", ctxWith(http2), false);
    expect(d?.confidence).toBeCloseTo(0.35);
  });

  it("text that is not a repository gives nothing and makes no request", async () => {
    const http = new FakeHttp();
    for (const input of ["coding agents", "@chamath", "https://cursor.com/changelog", "r/LocalLLaMA", "u/someone", "https://github.com/topics/ai"]) {
      expect(await connector.resolve(input, ctxWith(http), false)).toEqual([]);
    }
    expect(http.requests).toHaveLength(0);
  });

  it("with the GitHub chip, plain text searches repositories (keyless)", async () => {
    const http = new FakeHttp().onPrefix("https://api.github.com/search/repositories?", {
      text: loadFixture("search-repositories.json"),
    });
    const found = await connector.resolve("gemini cli", ctxWith(http), true);
    expect(http.urls[0]).toBe(
      "https://api.github.com/search/repositories?q=gemini%20cli%20in%3Aname%2Cdescription&per_page=3",
    );
    expect(found.map((c) => c.name)).toEqual(["google-gemini/gemini-cli", "router-for-me/CLIProxyAPI", "entireio/cli"]);
    expect(found[0]?.confidence).toBeCloseTo(0.4);
    expect(found[0]?.description).toMatch(/^GitHub repository\. An open-source AI agent/);
    expect(found[2]!.confidence).toBeLessThan(found[0]!.confidence);
  });

  it("search errors give nothing", async () => {
    const http = new FakeHttp().onPrefix("https://api.github.com/search/", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    expect(await connector.resolve("gemini cli", ctxWith(http), true)).toEqual([]);
    const http2 = new FakeHttp().onPrefix("https://api.github.com/search/", { text: "not json" });
    expect(await connector.resolve("gemini cli", ctxWith(http2), true)).toEqual([]);
  });

  it("r/name with the GitHub chip is a repository of the owner r", async () => {
    const http = new FakeHttp();
    expect(await connector.resolve("r/LocalLLaMA", ctxWith(http), true)).toEqual([]);
    expect(http.urls).toEqual(["https://github.com/r/LocalLLaMA/releases.atom"]);
  });
});

describe("fetch: releases", () => {
  it("first poll: the newest releases, newest first, with tag, links, and a cursor with the ETag", async () => {
    const http = new FakeHttp().on(CC_FEED, { text: ccAtom, etag: 'W/"v1"' });
    const cfg = config({ owner: "anthropics", repo: "claude-code" });
    const result = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(4);
    const first = result.items[0]!;
    expect(first.externalId).toBe("tag:github.com,2008:Repository/937253475/v2.1.329");
    expect(first.title).toBe("claude-code v2.1.329");
    expect(first.kind).toBe("release");
    expect(first.url).toBe("https://github.com/anthropics/claude-code/releases/tag/v2.1.329");
    expect(first.publishedAt).toBe(Date.parse("2026-11-19T22:14:41Z"));
    expect(first.text).toMatch(/^What's changed\n\n- Added a trust dialog warning/);
    expect(first.text).not.toMatch(/<|&lt;/);
    expect(first.meta).toEqual({ event: "release", repo: "anthropics/claude-code", tag: "v2.1.329", prerelease: false });
    for (const item of result.items) {
      expect(item.text.length).toBeLessThanOrEqual(20_000);
      expect((item.links ?? []).length).toBeLessThanOrEqual(10);
      for (const link of item.links ?? []) expect(link).toMatch(/^https?:\/\//);
    }
    const times = result.items.map((i) => i.publishedAt!);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(result.cursor?.releases?.etag).toBe('W/"v1"');
    expect(result.cursor?.releases?.seenIds).toHaveLength(4);
    expect(result.cursor?.advisories).toBeUndefined();
  });

  it("the first poll keeps at most `limit` items", async () => {
    const http = new FakeHttp().on(CC_FEED, { text: ccAtom });
    const result = await connector.fetch({
      config: config({ owner: "anthropics", repo: "claude-code" }), cursor: null, mode: "poll", limit: 2, ctx: ctxWith(http),
    });
    expect(result.items.map((i) => i.title)).toEqual(["claude-code v2.1.329", result.items[1]!.title]);
    expect(result.items).toHaveLength(2);
    expect(result.cursor?.releases?.seenIds).toHaveLength(4);
  });

  it("a later poll sends the ETag; 304 gives no item and keeps the cursor", async () => {
    const http = new FakeHttp().on(CC_FEED, { text: ccAtom, etag: 'W/"v1"' });
    const cfg = config({ owner: "anthropics", repo: "claude-code" });
    const ctx = ctxWith(http);
    const first = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx });
    const second = await connector.fetch({ config: cfg, cursor: first.cursor, mode: "poll", limit: 30, ctx });
    expect(http.requests[1]?.etag).toBe('W/"v1"');
    expect(second.items).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("a later poll returns only the releases that are new since the cursor", async () => {
    const cfg = config({ owner: "anthropics", repo: "claude-code" });
    const older = ccAtom.replace(/<entry>[\s\S]*?<\/entry>/, ""); // the newest entry is not there yet
    const http = new FakeHttp().on(CC_FEED, { text: older, etag: 'W/"v1"' });
    const ctx = ctxWith(http);
    const first = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx });
    expect(first.items).toHaveLength(3);
    http.reset().on(CC_FEED, { text: ccAtom, etag: 'W/"v2"' });
    const second = await connector.fetch({ config: cfg, cursor: first.cursor, mode: "poll", limit: 30, ctx });
    expect(second.items.map((i) => i.title)).toEqual(["claude-code v2.1.329"]);
    expect(second.cursor?.releases?.etag).toBe('W/"v2"');
    expect(second.cursor?.releases?.seenIds[0]).toBe("tag:github.com,2008:Repository/937253475/v2.1.329");
  });

  it("prereleases off: skips tags with a pre-release part (codex alpha tags)", async () => {
    const http = new FakeHttp().on(CODEX_FEED, { text: codexAtom });
    const result = await connector.fetch({
      config: config({ owner: "openai", repo: "codex" }), cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http),
    });
    expect(result.items.map((i) => (i.meta as { tag: string }).tag)).toEqual(["rust-v0.171.0"]);
    expect(result.items[0]?.title).toBe("codex 0.171.0");
    // The skipped prereleases are seen: they never come back.
    expect(result.cursor?.releases?.seenIds).toHaveLength(6);
  });

  it("prereleases on: keeps them and marks them", async () => {
    const http = new FakeHttp().on(CODEX_FEED, { text: codexAtom });
    const result = await connector.fetch({
      config: config({ owner: "openai", repo: "codex", prereleases: true }), cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http),
    });
    expect(result.items).toHaveLength(6);
    expect(result.items.filter((i) => (i.meta as { prerelease: boolean }).prerelease)).toHaveLength(5);
  });

  it("prereleases off: the MCP release candidates (\"-RC\") are skipped, \"-final\" stays", async () => {
    const http = new FakeHttp().on(MCP_FEED, { text: mcpAtom });
    const result = await connector.fetch({
      config: config({ owner: "modelcontextprotocol", repo: "modelcontextprotocol" }), cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http),
    });
    const tags = result.items.map((i) => (i.meta as { tag: string }).tag);
    expect(tags).not.toContain("2026-07-28-RC");
    expect(tags).not.toContain("2025-11-25-RC");
    expect(tags).toContain("2024-11-05-final");
    expect(tags[0]).toBe("2026-07-28");
    expect(result.items[0]?.title).toBe("modelcontextprotocol 2026-07-28");
  });

  it("with GITHUB_TOKEN the REST prerelease flag also counts (and the token goes only to the API)", async () => {
    const http = new FakeHttp()
      .on(CODEX_FEED, { text: codexAtom })
      .on("https://api.github.com/repos/openai/codex/releases?per_page=30", { text: loadFixture("releases-rest.synthetic.json") });
    const result = await connector.fetch({
      config: config({ owner: "openai", repo: "codex" }), cursor: null, mode: "poll", limit: 30,
      ctx: ctxWith(http, { GITHUB_TOKEN: "test-token" }),
    });
    // The synthetic REST answer marks rust-v0.171.0 as a prerelease: nothing is left.
    expect(result.items).toEqual([]);
    expect(http.requests[0]?.headers?.Authorization).toBeUndefined();
    expect(http.requests[1]?.headers?.Authorization).toBe("Bearer test-token");
  });

  it("a failing REST call falls back to the tag pattern", async () => {
    const http = new FakeHttp()
      .on(CODEX_FEED, { text: codexAtom })
      .on("https://api.github.com/repos/openai/codex/releases?per_page=30", { status: 500, text: "" });
    const result = await connector.fetch({
      config: config({ owner: "openai", repo: "codex" }), cursor: null, mode: "poll", limit: 30,
      ctx: ctxWith(http, { GITHUB_TOKEN: "test-token" }),
    });
    expect(result.items.map((i) => (i.meta as { tag: string }).tag)).toEqual(["rust-v0.171.0"]);
  });

  it("errors: 404, 429, a page that is not a feed, a timeout", async () => {
    const cfg = config({ owner: "anthropics", repo: "claude-code" });
    const run = (http: FakeHttp) => connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    await expectConnectorError(run(new FakeHttp().on(CC_FEED, { status: 404, text: "Not Found" })), "not_found", /anthropics\/claude-code was not found/);
    await expectConnectorError(run(new FakeHttp().on(CC_FEED, { status: 429, headers: { "retry-after": "120" } })), "rate_limited", /12:02 UTC/);
    await expectConnectorError(run(new FakeHttp().on(CC_FEED, { text: "<html><body>Hello</body></html>" })), "bad_response");
    await expectConnectorError(run(new FakeHttp().on(CC_FEED, { status: 500, text: "" })), "bad_response", /status 500/);
    await expectConnectorError(run(new FakeHttp().on(CC_FEED, { error: new HttpError("timeout", "t") })), "network", /did not answer in time/);
    await expectConnectorError(run(new FakeHttp().on(CC_FEED, { error: new HttpError("network", "x") })), "network");
  });

  it("preview: no cursor, at most 10 items, and no conditional request", async () => {
    const http = new FakeHttp().on(CC_FEED, { text: ccAtom, etag: 'W/"v1"' });
    const cursor: GithubCursor = { releases: { etag: 'W/"v1"', seenIds: ["tag:github.com,2008:Repository/937253475/v2.1.329"] } };
    const result = await connector.fetch({
      config: config({ owner: "anthropics", repo: "claude-code" }), cursor, mode: "preview", limit: 30, ctx: ctxWith(http),
    });
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(4);
    expect(http.requests[0]?.etag).toBeUndefined();
  });

  it("odd input: an empty feed, and entries with no content", async () => {
    const feed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from tool</title>' +
      '<entry><id>tag:github.com,2008:Repository/1/v1.0.0</id><updated>2026-11-19T10:00:00Z</updated>' +
      '<link rel="alternate" type="text/html" href="https://github.com/acme/tool/releases/tag/v1.0.0"/><title></title>' +
      '<content type="html"></content></entry></feed>';
    const http = new FakeHttp().on("https://github.com/acme/tool/releases.atom", { text: feed });
    const result = await connector.fetch({ config: config({ owner: "acme", repo: "tool" }), cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("tool v1.0.0");
    expect(result.items[0]?.text).toBe("Release v1.0.0 of acme/tool.");
  });
});

describe("fetch: advisories", () => {
  const cfg = config({ owner: "anthropics", repo: "claude-code", releases: false, advisories: true });

  it("first poll: published advisories, newest first, without a token", async () => {
    const http = new FakeHttp().on(CC_ADVISORIES, { text: advisoriesJson, etag: 'W/"a1"', lastModified: "Mon, 26 Oct 2026 11:43:04 GMT" });
    const result = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http, { GITHUB_TOKEN: "test-token" }) });
    expect(http.requests[0]?.headers?.Authorization).toBeUndefined();
    expect(http.requests[0]?.headers?.Accept).toBe("application/vnd.github+json");
    expect(result.items).toHaveLength(4);
    const first = result.items[0]!;
    expect(first.externalId).toBe("advisory:GHSA-5xjx-9qx6-jcrv");
    expect(first.kind).toBe("advisory");
    expect(first.title).toBe(
      "Security advisory for anthropics/claude-code: TOCTOU Race in Edit Tool Allows File Writes Outside the Workspace",
    );
    expect(first.url).toBe("https://github.com/anthropics/claude-code/security/advisories/GHSA-5xjx-9qx6-jcrv");
    expect(first.publishedAt).toBe(Date.parse("2026-10-26T11:43:04Z"));
    expect(first.text).toMatch(/^Severity: high \(CVSS 7\.7\)\nAdvisory: GHSA-5xjx-9qx6-jcrv \(CVE-2026-88968\)\nAffected: npm @anthropic-ai\/claude-code < 2\.1\.251; patched: 2\.1\.251\n\nClaude Code validated/);
    expect(first.links?.[0]).toBe(first.url);
    expect(first.meta).toMatchObject({ event: "advisory", severity: "high", ghsaId: "GHSA-5xjx-9qx6-jcrv" });
    expect(result.cursor?.advisories).toEqual({
      etag: 'W/"a1"',
      lastModified: "Mon, 26 Oct 2026 11:43:04 GMT",
      seenIds: ["GHSA-5xjx-9qx6-jcrv", "GHSA-4p2j-qj3c-6x84", "GHSA-pq7j-f95f-qfcv", "GHSA-5j29-h97v-84ch"],
    });
    expect(result.cursor?.releases).toBeUndefined();
  });

  it("later polls: 304, and then one new advisory", async () => {
    const http = new FakeHttp().on(CC_ADVISORIES, { text: advisoriesJson, etag: 'W/"a1"' });
    const ctx = ctxWith(http);
    const first = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx });
    const second = await connector.fetch({ config: cfg, cursor: first.cursor, mode: "poll", limit: 30, ctx });
    expect(http.requests[1]?.etag).toBe('W/"a1"');
    expect(second.items).toEqual([]);
    const list = JSON.parse(advisoriesJson) as Array<Record<string, unknown>>;
    const added = { ...list[0], ghsa_id: "GHSA-aaaa-bbbb-cccc", summary: "New problem", published_at: "2026-11-20T10:00:00Z", cve_id: null };
    const withdrawn = { ...list[0], ghsa_id: "GHSA-wwww-wwww-wwww", withdrawn_at: "2026-11-20T11:00:00Z" };
    http.reset().on(CC_ADVISORIES, { json: [withdrawn, added, ...list], etag: 'W/"a2"' });
    const third = await connector.fetch({ config: cfg, cursor: second.cursor, mode: "poll", limit: 30, ctx });
    expect(third.items.map((i) => i.externalId)).toEqual(["advisory:GHSA-aaaa-bbbb-cccc"]);
    expect(third.items[0]?.text).toMatch(/^Severity: high \(CVSS 7\.7\)\nAdvisory: GHSA-aaaa-bbbb-cccc\n/);
  });

  it("403 and 429 with the rate-limit headers: rate_limited with the reset time", async () => {
    const reset = Math.floor(Date.parse("2026-11-20T13:15:00Z") / 1000);
    for (const status of [403, 429]) {
      const http = new FakeHttp().on(CC_ADVISORIES, {
        status,
        headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        json: { message: "API rate limit exceeded" },
      });
      await expectConnectorError(
        connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }),
        "rate_limited",
        /The limit resets at 13:15 UTC\./,
      );
    }
    const tomorrow = Math.floor(Date.parse("2026-11-21T00:30:00Z") / 1000);
    const http = new FakeHttp().on(CC_ADVISORIES, {
      status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(tomorrow) },
    });
    await expectConnectorError(
      connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }),
      "rate_limited",
      /21 Nov 00:30 UTC/,
    );
  });

  it("403 without rate-limit signs is blocked; 404 is not_found; bad JSON is bad_response", async () => {
    const run = (http: FakeHttp) => connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    await expectConnectorError(run(new FakeHttp().on(CC_ADVISORIES, { status: 403, headers: { "x-ratelimit-remaining": "40" } })), "blocked");
    await expectConnectorError(
      run(new FakeHttp().on(CC_ADVISORIES, { status: 404, text: loadFixture("advisories-not-found.json") })),
      "not_found",
      /security advisories are not public/,
    );
    await expectConnectorError(run(new FakeHttp().on(CC_ADVISORIES, { text: "{not json" })), "bad_response");
    await expectConnectorError(run(new FakeHttp().on(CC_ADVISORIES, { json: { message: "x" } })), "bad_response");
  });

  it("odd entries are skipped, not fatal", async () => {
    const http = new FakeHttp().on(CC_ADVISORIES, {
      json: [{ nothing: true }, { ghsa_id: "GHSA-only-the-id", summary: null, html_url: "javascript:alert(1)" }],
    });
    const result = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe("https://github.com/anthropics/claude-code/security/advisories/GHSA-only-the-id");
    expect(result.items[0]?.publishedAt).toBeUndefined();
  });

  it("preview asks for 5 advisories", async () => {
    const url = "https://api.github.com/repos/anthropics/claude-code/security-advisories?per_page=5&sort=published&direction=desc";
    const http = new FakeHttp().on(url, { text: advisoriesJson });
    const result = await connector.fetch({ config: cfg, cursor: null, mode: "preview", limit: 10, ctx: ctxWith(http) });
    expect(http.urls).toEqual([url]);
    expect(result.cursor).toBeNull();
  });
});

describe("fetch: discussions", () => {
  const cfg = config({ owner: "example-org", repo: "example-repo", releases: false, discussions: true });
  const discussions = loadFixture("discussions.synthetic.json");

  it("without GITHUB_TOKEN discussions are skipped with no request", async () => {
    const http = new FakeHttp();
    const result = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items).toEqual([]);
    expect(http.requests).toHaveLength(0);
    expect(result.cursor).toEqual({});
  });

  it("with the token: newest first, a POST with the query and the variables", async () => {
    const http = new FakeHttp().on(GRAPHQL, { text: discussions });
    const result = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http, { GITHUB_TOKEN: "test-token" }) });
    const req = http.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers?.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(req.body ?? "{}") as { query: string; variables: unknown };
    expect(body.variables).toEqual({ owner: "example-org", name: "example-repo", first: 30 });
    expect(body.query).toMatch(/orderBy: \{ field: CREATED_AT, direction: DESC \}/);
    expect(result.items.map((i) => i.title)).toEqual([
      "Proposal: a hook that runs before each tool call",
      "Version 3.0 is out: what changed for plugin authors",
      "How do I set the proxy?",
    ]);
    const first = result.items[0]!;
    expect(first).toMatchObject({
      externalId: "discussion:D_kwDOSynthetic0003",
      kind: "discussion",
      url: "https://github.com/example-org/example-repo/discussions/103",
      author: "example-user-a",
      publishedAt: Date.parse("2026-11-19T15:00:00Z"),
      links: ["https://example.com/design/hooks"],
    });
    expect(first.meta).toMatchObject({ category: "Ideas", comments: 12, upvotes: 40 });
    expect(result.items[2]?.author).toBeUndefined();
    expect(result.cursor?.discussions?.seenIds).toHaveLength(3);
  });

  it("the categories filter (name or slug, any case) and a larger page", async () => {
    const http = new FakeHttp().on(GRAPHQL, { text: discussions });
    const result = await connector.fetch({
      config: { ...cfg, discussionCategories: ["announcements", "Q-A"] }, cursor: null, mode: "poll", limit: 30,
      ctx: ctxWith(http, { GITHUB_TOKEN: "test-token" }),
    });
    expect(result.items.map((i) => i.externalId)).toEqual(["discussion:D_kwDOSynthetic0002", "discussion:D_kwDOSynthetic0001"]);
    expect((JSON.parse(http.requests[0]!.body!) as { variables: { first: number } }).variables.first).toBe(50);
  });

  it("a later poll returns only new discussions", async () => {
    const http = new FakeHttp().on(GRAPHQL, { text: discussions });
    const ctx = ctxWith(http, { GITHUB_TOKEN: "test-token" });
    const first = await connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx });
    const data = JSON.parse(discussions) as { data: { repository: { discussions: { nodes: Array<Record<string, unknown>> } } } };
    data.data.repository.discussions.nodes.unshift({
      id: "D_kwDOSynthetic0004", number: 104, title: "New one", createdAt: "2026-11-20T08:00:00Z", bodyText: "Text",
      url: "https://github.com/example-org/example-repo/discussions/104", category: { name: "Ideas", slug: "ideas" },
    });
    http.reset().on(GRAPHQL, { json: data });
    const second = await connector.fetch({ config: cfg, cursor: first.cursor, mode: "poll", limit: 30, ctx });
    expect(second.items.map((i) => i.title)).toEqual(["New one"]);
  });

  it("errors: NOT_FOUND, RATE_LIMITED, 401, disabled discussions", async () => {
    const run = (reply: Parameters<FakeHttp["on"]>[1]) =>
      connector.fetch({ config: cfg, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(new FakeHttp().on(GRAPHQL, reply), { GITHUB_TOKEN: "t" }) });
    await expectConnectorError(run({ text: loadFixture("discussions-not-found.synthetic.json") }), "not_found");
    await expectConnectorError(run({ text: loadFixture("discussions-rate-limited.synthetic.json") }), "rate_limited");
    await expectConnectorError(run({ status: 401, json: { message: "Bad credentials" } }), "needs_credentials", /GITHUB_TOKEN/);
    await expectConnectorError(run({ json: { errors: [{ message: "Something else" }] } }), "bad_response", /Something else/);
    await expectConnectorError(run({ json: { data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "No access" }] } }), "bad_response", /No access/);
    await expectConnectorError(run({ text: "<html>" }), "bad_response");
    const disabled = await run({ text: loadFixture("discussions-disabled.synthetic.json") });
    expect(disabled.items).toEqual([]);
  });
});

describe("fetch: all event types", () => {
  it("merges the types newest first; one sub-state for each type; a switched-off type keeps its state", async () => {
    const http = new FakeHttp()
      .on(CC_FEED, { text: ccAtom, etag: 'W/"r1"' })
      .on(CC_ADVISORIES, { text: advisoriesJson, etag: 'W/"a1"' });
    const all = config({ owner: "anthropics", repo: "claude-code", advisories: true, discussions: true });
    const ctx = ctxWith(http);
    const first = await connector.fetch({ config: all, cursor: null, mode: "poll", limit: 30, ctx });
    expect(first.items).toHaveLength(8);
    expect(first.items[0]?.kind).toBe("release");
    expect(first.items.at(-1)?.kind).toBe("advisory");
    expect(Object.keys(first.cursor ?? {}).sort()).toEqual(["advisories", "releases"]);

    const releasesOnly = { ...all, advisories: false };
    const second = await connector.fetch({ config: releasesOnly, cursor: first.cursor, mode: "poll", limit: 30, ctx });
    expect(second.items).toEqual([]);
    expect(second.cursor?.advisories).toEqual(first.cursor?.advisories);
    expect(http.count(CC_ADVISORIES)).toBe(1);
  });

  it("an error of one type fails the poll (the pipeline keeps the old cursor)", async () => {
    const http = new FakeHttp()
      .on(CC_FEED, { text: ccAtom })
      .on(CC_ADVISORIES, { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795180453" } });
    await expectConnectorError(
      connector.fetch({ config: config({ owner: "anthropics", repo: "claude-code", advisories: true }), cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) }),
      "rate_limited",
    );
  });
});
