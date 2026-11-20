import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpError } from "@/lib/http/types";
import { FakeHttp, loadFixture, makeConnectorContext } from "@/test/helpers";

import { parseConfig, type ResearchConfig } from "../configs";
import { ConnectorError, type ConnectorContext } from "../types";
import { arxivIdOf, arxivSearchQuery, parseArxivFeed, setArxivPacingForTests } from "./arxiv";
import { connector, type ResearchCursor } from "./index";
import { abstractFromIndex, institutionIdOf } from "./openalex";

const NOW = Date.parse("2026-11-20T09:00:00Z");

const arxivQuery = loadFixture("arxiv-query.xml");
const arxivAuthor = loadFixture("arxiv-author.xml");
const arxivError = loadFixture("arxiv-error.xml");
const arxivEmpty = loadFixture("arxiv-empty.xml");
const authorPage = loadFixture("arxiv-author-page.html");
const institutions = loadFixture("openalex-institutions.json");
const institution = loadFixture("openalex-institution.json");
const openalex404 = loadFixture("openalex-404.json");
const works = loadFixture("openalex-works.json");

const cfg = (value: unknown) => parseConfig("research", value) as ResearchConfig;
const arxivCfg = (value: unknown) => cfg(value) as Exclude<ResearchConfig, { variant: "openalex_institution" }>;
const ctxWith = (http: FakeHttp, extra: Partial<ConnectorContext> = {}) => makeConnectorContext({ http, now: () => NOW, ...extra });

async function expectError(promise: Promise<unknown>, kind: ConnectorError["kind"], message?: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).kind).toBe(kind);
  if (message) expect((error as ConnectorError).message).toMatch(message);
}

beforeEach(() => setArxivPacingForTests(0));
afterEach(() => setArxivPacingForTests(null));

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe("research resolve", () => {
  it("an arXiv listing link: every new paper of the category, with a warning", async () => {
    const http = new FakeHttp();
    const [c, ...rest] = await connector.resolve("https://arxiv.org/list/cs.AI/recent", ctxWith(http), false);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ type: "research", name: "arXiv cs.AI: all new papers", confidence: 0.9 });
    expect(c!.config).toEqual({ variant: "arxiv_query", query: "*", categories: ["cs.AI"] });
    expect(c!.warnings?.[0]).toMatch(/every new paper in cs\.AI/);
    expect(connector.configSchema.parse(c!.config)).toEqual(c!.config);
    expect(http.requests).toHaveLength(0);
  });

  it("an arXiv author link: the name from the author page", async () => {
    const http = new FakeHttp().on("https://arxiv.org/a/liang_p_1", { text: authorPage });
    const [c] = await connector.resolve("arxiv.org/a/liang_p_1.html", ctxWith(http), false);
    expect(c).toMatchObject({ name: "arXiv: Peng Liang", confidence: 0.9 });
    expect(c!.config).toEqual({ variant: "arxiv_author", author: "Peng Liang" });
  });

  it("an arXiv author link whose page fails: a low-confidence guess with a warning", async () => {
    const http = new FakeHttp().onPrefix("https://arxiv.org/a/", { error: new HttpError("timeout", "slow") });
    const [c] = await connector.resolve("https://arxiv.org/a/liang_p_1", ctxWith(http), false);
    expect(c).toMatchObject({ confidence: 0.4, config: { variant: "arxiv_author", author: "Liang" } });
    expect(c!.warnings).toHaveLength(1);
  });

  it("an arXiv search link: a topic or an author", async () => {
    const ctx = ctxWith(new FakeHttp());
    const [topic] = await connector.resolve("https://arxiv.org/search/?query=agent+evaluation&searchtype=all", ctx, false);
    expect(topic!.config).toEqual({ variant: "arxiv_query", query: "agent evaluation", categories: [] });
    const [author] = await connector.resolve("https://arxiv.org/search/?query=Yann+LeCun&searchtype=author", ctx, false);
    expect(author!.config).toEqual({ variant: "arxiv_author", author: "Yann LeCun" });
    expect(await connector.resolve("https://arxiv.org/abs/2611.26624", ctx, false)).toEqual([]);
    expect(await connector.resolve("https://arxiv.org/search/?searchtype=all", ctx, false)).toEqual([]);
  });

  it("plain text: a low-confidence topic and no request; forced: a topic, an author guess, and OpenAlex labs", async () => {
    const http = new FakeHttp().onPrefix("https://api.openalex.org/institutions?", { text: institutions });
    const plain = await connector.resolve("agent evaluation", ctxWith(http), false);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ confidence: 0.3, config: { variant: "arxiv_query", query: "agent evaluation" } });
    expect(http.requests).toHaveLength(0);

    const forced = await connector.resolve("Allen Institute", ctxWith(http), true);
    expect(forced.map((c) => (c.config as ResearchConfig).variant)).toEqual(["arxiv_query", "arxiv_author", "openalex_institution"]);
    const lab = forced[2]!;
    expect(lab.config).toEqual({ variant: "openalex_institution", institutionId: "I4210156221", name: "Allen Institute for Artificial Intelligence" });
    expect(lab.description).toMatch(/nonprofit, US/);
    expect(connector.configSchema.parse(lab.config)).toEqual(lab.config);
    const url = new URL(http.urls[0]!);
    expect(url.searchParams.get("search")).toBe("Allen Institute");
    expect(url.search).not.toMatch(/mailto|email|api_key/);
  });

  it("an exact institution name ranks high; a failed lookup adds nothing", async () => {
    const http = new FakeHttp().onPrefix("https://api.openalex.org/institutions?", { text: institutions });
    const found = await connector.resolve("Allen Institute for Artificial Intelligence", ctxWith(http), true);
    expect(found.find((c) => (c.config as ResearchConfig).variant === "openalex_institution")!.confidence).toBe(0.8);
    const broken = new FakeHttp().onPrefix("https://api.openalex.org/", { status: 500, text: "" });
    const only = await connector.resolve("deep learning lab", ctxWith(broken), true);
    expect(only.map((c) => (c.config as ResearchConfig).variant)).toEqual(["arxiv_query"]);
  });

  it("prefixes and OpenAlex links", async () => {
    const http = new FakeHttp()
      .on("https://api.openalex.org/institutions/I4210156221?select=id,display_name,country_code,type,works_count,homepage_url", { text: institution })
      .onPrefix("https://api.openalex.org/institutions/I1?", { status: 404, text: openalex404 });
    const ctx = ctxWith(http);
    expect((await connector.resolve("arxiv: agent evals", ctx, false))[0]!.config).toMatchObject({ query: "agent evals" });
    expect((await connector.resolve("author: Jane Q. Doe", ctx, false))[0]!.config).toEqual({ variant: "arxiv_author", author: "Jane Q. Doe" });
    const [lab] = await connector.resolve("https://openalex.org/I4210156221", ctx, false);
    expect(lab).toMatchObject({ confidence: 0.95, config: { institutionId: "I4210156221", name: "Allen Institute for Artificial Intelligence" } });
    expect(await connector.resolve("https://openalex.org/institutions/I1", ctx, false)).toEqual([]);
    expect(await connector.resolve("https://openalex.org/W123", ctx, false)).toEqual([]);
  });

  it("odd input gives []", async () => {
    const ctx = ctxWith(new FakeHttp());
    for (const input of ["", "  ", "@someone", "news@example.com", "...", "https://example.com/paper", "author:   "]) {
      expect(await connector.resolve(input, ctx, false)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// arXiv
// ---------------------------------------------------------------------------

describe("arxiv query building", () => {
  it("words, phrases, categories, the author, and the arXiv syntax", () => {
    expect(arxivSearchQuery(arxivCfg({ variant: "arxiv_query", query: "agent evaluation", categories: ["cs.AI", "cs.CL"] }))).toBe(
      "(all:agent AND all:evaluation) AND (cat:cs.AI OR cat:cs.CL)",
    );
    expect(arxivSearchQuery(arxivCfg({ variant: "arxiv_query", query: '"tool use" agents' }))).toBe('(all:"tool use" AND all:agents)');
    expect(arxivSearchQuery(arxivCfg({ variant: "arxiv_query", query: "*", categories: ["cs.SE"] }))).toBe("cat:cs.SE");
    expect(arxivSearchQuery(arxivCfg({ variant: "arxiv_query", query: "ti:agents AND abs:benchmark" }))).toBe("(ti:agents AND abs:benchmark)");
    expect(arxivSearchQuery(arxivCfg({ variant: "arxiv_author", author: 'Percy "P." Liang' }))).toBe('au:"Percy P. Liang"');
    expect(() => arxivSearchQuery(arxivCfg({ variant: "arxiv_query", query: "*" }))).toThrow(ConnectorError);
  });

  it("arXiv ids with no version", () => {
    expect(arxivIdOf("http://arxiv.org/abs/2611.26624v3")).toEqual({ id: "2611.26624", version: "v3" });
    expect(arxivIdOf("http://arxiv.org/abs/hep-th/9901001v1")).toEqual({ id: "hep-th/9901001", version: "v1" });
    expect(arxivIdOf("https://arxiv.org/api/errors#bad")).toBeNull();
  });
});

describe("research fetch: arxiv", () => {
  const query = cfg({ variant: "arxiv_query", query: "agent evaluation", categories: ["cs.AI", "cs.CL"] });

  it("first poll: the request, the items, the cursor", async () => {
    const http = new FakeHttp().onPrefix("https://export.arxiv.org/api/query?", { text: arxivQuery });
    const result = await connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });

    const url = new URL(http.urls[0]!);
    expect(url.searchParams.get("search_query")).toBe("(all:agent AND all:evaluation) AND (cat:cs.AI OR cat:cs.CL)");
    expect(url.searchParams.get("sortBy")).toBe("submittedDate");
    expect(url.searchParams.get("sortOrder")).toBe("descending");
    expect(url.searchParams.get("max_results")).toBe("30");

    expect(result.items.map((i) => i.externalId)).toEqual(["2611.26624", "2611.26613", "2611.26510", "2611.26491", "2611.26444"]);
    const paper = result.items[2]!;
    expect(paper).toMatchObject({ kind: "paper", url: "https://arxiv.org/abs/2611.26510", publishedAt: Date.parse("2026-11-19T17:57:59Z") });
    expect(paper.links!.slice(0, 2)).toEqual(["https://arxiv.org/abs/2611.26510", "https://arxiv.org/pdf/2611.26510"]);
    expect(paper.links).toContain("https://github.com/RUCAIBox/AutoMaster");
    expect(paper.text.length).toBeGreaterThan(200);
    expect(paper.text).not.toMatch(/\n/);
    expect(paper.meta).toMatchObject({ site: "arxiv", primaryCategory: expect.any(String), version: "v1" });
    expect((paper.meta!.authors as string[]).length).toBeGreaterThan(0);
    for (const item of result.items) expect(item.links!.length).toBeLessThanOrEqual(10);
    expect(result.cursor).toEqual({ variant: "arxiv_query", seenIds: ["2611.26624", "2611.26613", "2611.26510", "2611.26491", "2611.26444"] });
  });

  it("a later poll returns only papers that the cursor has not seen", async () => {
    const http = new FakeHttp().onPrefix("https://export.arxiv.org/", { text: arxivQuery });
    const cursor: ResearchCursor = { variant: "arxiv_query", seenIds: ["2611.26510", "2611.26491", "2611.26444"] };
    const result = await connector.fetch({ config: query, cursor, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result.items.map((i) => i.externalId)).toEqual(["2611.26624", "2611.26613"]);
    expect(result.cursor!.seenIds).toEqual(["2611.26624", "2611.26613", "2611.26510", "2611.26491", "2611.26444"]);
  });

  it("the author variant and the preview", async () => {
    const http = new FakeHttp().onPrefix("https://export.arxiv.org/", { text: arxivAuthor });
    const config = cfg({ variant: "arxiv_author", author: "Percy Liang" });
    const result = await connector.fetch({ config, cursor: null, mode: "preview", limit: 3, ctx: ctxWith(http) });
    expect(new URL(http.urls[0]!).searchParams.get("search_query")).toBe('au:"Percy Liang"');
    expect(new URL(http.urls[0]!).searchParams.get("max_results")).toBe("3");
    expect(result.cursor).toBeNull();
    expect(result.items).toHaveLength(3);
  });

  it("an empty answer gives no items", async () => {
    const http = new FakeHttp().onPrefix("https://export.arxiv.org/", { text: arxivEmpty });
    const result = await connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    expect(result).toEqual({ items: [], cursor: { variant: "arxiv_query", seenIds: [] } });
  });

  it("error kinds", async () => {
    const run = (reply: Parameters<FakeHttp["onPrefix"]>[1]) =>
      connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(new FakeHttp().onPrefix("https://export.arxiv.org/", reply)) });
    await expectError(run({ text: arxivError }), "bad_response", /arXiv refused the query: max_results must be non-negative/);
    await expectError(run({ status: 400, text: arxivError }), "bad_response", /refused/);
    await expectError(run({ status: 503, text: "" }), "rate_limited");
    await expectError(run({ status: 429, text: "" }), "rate_limited");
    await expectError(run({ status: 502, text: "" }), "network");
    await expectError(run({ text: "<html><body>maintenance</body></html>" }), "bad_response");
    await expectError(run({ text: "not xml at all" }), "bad_response");
    await expectError(run({ error: new HttpError("timeout", "slow") }), "network");
  });

  it("waits 3 s between two arXiv requests", async () => {
    setArxivPacingForTests(120);
    const http = new FakeHttp().onPrefix("https://export.arxiv.org/", { text: arxivEmpty });
    const ctx = ctxWith(http);
    const start = Date.now();
    await Promise.all([
      connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx }),
      connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx }),
      connector.fetch({ config: query, cursor: null, mode: "poll", limit: 30, ctx }),
    ]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(230);
    expect(http.requests).toHaveLength(3);
  });

  it("odd entries are skipped", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>http://arxiv.org/abs/not-an-id</id><title>Bad id</title></entry>
      <entry><id>http://arxiv.org/abs/2611.00001v2</id><title>  A   title &amp; more </title><summary> Line one
      line two </summary><published>bad date</published></entry></feed>`;
    const items = parseArxivFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "2611.00001", title: "A title & more", text: "Line one line two" });
    expect(items[0]!.publishedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

describe("research fetch: openalex_institution", () => {
  const config = cfg({ variant: "openalex_institution", institutionId: "I4210156221", name: "Allen Institute for AI" });

  it("first poll: works of the institution, newest publication first, no email in the request", async () => {
    const http = new FakeHttp().onPrefix("https://api.openalex.org/works?", { text: works });
    const result = await connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(http) });
    const url = new URL(http.urls[0]!);
    expect(url.searchParams.get("filter")).toBe("authorships.institutions.lineage:I4210156221,to_publication_date:2026-11-20");
    expect(url.searchParams.get("sort")).toBe("publication_date:desc");
    expect(url.search).not.toMatch(/mailto|email|api_key/);

    expect(result.items).toHaveLength(6);
    const first = result.items[0]!;
    expect(first).toMatchObject({
      externalId: "W7131857336",
      url: "https://doi.org/10.21203/rs.3.rs-8931286/v1",
      kind: "paper",
      publishedAt: Date.parse("2026-11-12T00:00:00Z"),
      meta: { site: "openalex", institution: "Allen Institute for AI" },
    });
    expect(first.text.split(" ").length).toBeGreaterThan(20);
    expect(first.links).toContain("https://arxiv.org/abs/2602.23146");
    expect(first.links).toContain("https://openalex.org/W7131857336");
    expect(result.items[5]!.text).toBe("");
    expect(result.cursor!.seenIds).toHaveLength(6);
  });

  it("a later poll and the preview", async () => {
    const http = new FakeHttp().onPrefix("https://api.openalex.org/works?", { text: works });
    const later = await connector.fetch({
      config,
      cursor: { variant: "openalex_institution", seenIds: ["W7163995211", "W7225753641", "W7225453876", "W7225335510", "W7225424798"] },
      mode: "poll",
      limit: 30,
      ctx: ctxWith(http),
    });
    expect(later.items.map((i) => i.externalId)).toEqual(["W7131857336"]);
    const preview = await connector.fetch({ config, cursor: null, mode: "preview", limit: 2, ctx: ctxWith(http) });
    expect(preview.items).toHaveLength(2);
    expect(preview.cursor).toBeNull();
    expect(new URL(http.urls[1]!).searchParams.get("per_page")).toBe("2");
  });

  it("error kinds", async () => {
    const run = (reply: Parameters<FakeHttp["onPrefix"]>[1]) =>
      connector.fetch({ config, cursor: null, mode: "poll", limit: 30, ctx: ctxWith(new FakeHttp().onPrefix("https://api.openalex.org/", reply)) });
    await expectError(run({ status: 404, text: openalex404 }), "not_found", /I4210156221/);
    await expectError(run({ status: 429, text: "" }), "rate_limited");
    await expectError(run({ status: 403, text: "" }), "blocked");
    await expectError(run({ status: 500, text: "" }), "network");
    await expectError(run({ text: "{" }), "bad_response");
    await expectError(run({ json: { meta: {} } }), "bad_response");
  });

  it("helpers: the abstract from the inverted index, institution ids", () => {
    expect(abstractFromIndex({ world: [1], Hello: [0], again: [3], the: [2] })).toBe("Hello world the again");
    expect(abstractFromIndex({ bad: [-1, 1e9, "x"] })).toBe("");
    expect(abstractFromIndex(null)).toBe("");
    expect(institutionIdOf("https://openalex.org/I4210156221")).toBe("I4210156221");
    expect(institutionIdOf("i63966007")).toBe("I63966007");
    expect(institutionIdOf("W123")).toBeNull();
  });
});
