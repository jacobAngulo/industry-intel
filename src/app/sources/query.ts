// The query parameters of the source directory (specification §4.5).
// Pure, so that the tests can check them.
import type { SourceStatus } from "@/lib/services/types";
import { SOURCE_TYPES, type SourceType } from "@/lib/types";

export type DirectorySort = "name" | "last_check" | "useful";

export interface DirectoryQuery {
  type: SourceType | null;
  status: SourceStatus | null;
  /** A feed id or slug, as given. */
  feed: string | null;
  ownerMe: boolean;
  q: string;
  sort: DirectorySort;
}

export type SearchParams = Record<string, string | string[] | undefined>;

const STATUSES: readonly SourceStatus[] = ["paused", "needs_token", "needs_setup", "failing", "waiting", "active"];
const SORTS: readonly DirectorySort[] = ["name", "last_check", "useful"];

/** The types that show the compact list and the "Add more" box (§4.5 list mechanism). */
export const LIST_MECHANISM_TYPES: readonly SourceType[] = ["x_user", "x_search", "podcast"];

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function parseDirectoryQuery(params: SearchParams): DirectoryQuery {
  const type = first(params.type);
  const status = first(params.status);
  const sort = first(params.sort);
  const feed = first(params.feed);
  return {
    type: (SOURCE_TYPES as readonly string[]).includes(type) ? (type as SourceType) : null,
    status: (STATUSES as readonly string[]).includes(status) ? (status as SourceStatus) : null,
    feed: /^[a-z0-9-]{1,80}$/i.test(feed) ? feed : null,
    ownerMe: first(params.owner) === "me",
    q: first(params.q).slice(0, 120),
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as DirectorySort) : "name",
  };
}

/** The address of the directory with the query, changed by `patch`. Default values are left out. */
export function directoryHref(query: DirectoryQuery, patch: Partial<DirectoryQuery> = {}): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.type) params.set("type", next.type);
  if (next.status) params.set("status", next.status);
  if (next.feed) params.set("feed", next.feed);
  if (next.ownerMe) params.set("owner", "me");
  if (next.q) params.set("q", next.q);
  if (next.sort !== "name") params.set("sort", next.sort);
  const text = params.toString();
  return text ? `/sources?${text}` : "/sources";
}

/** True when a filter other than the type chip is set. */
export function hasFilters(query: DirectoryQuery): boolean {
  return query.status !== null || query.feed !== null || query.ownerMe || query.q !== "";
}
