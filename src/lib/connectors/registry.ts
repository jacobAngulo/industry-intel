// The registry of the 11 connectors (specification §6.2). Each connector is
// the export `connector` of the fixed path src/lib/connectors/<type>/index.ts.
import { SOURCE_TYPES, type SourceType } from "@/lib/types";

import { connector as blog } from "./blog";
import { connector as community } from "./community";
import { connector as docs } from "./docs";
import { connector as github } from "./github";
import { connector as newsletter } from "./newsletter";
import { connector as podcast } from "./podcast";
import { connector as research } from "./research";
import type { Candidate, Connector, ConnectorContext } from "./types";
import { connector as webSearch } from "./web_search";
import { connector as xSearch } from "./x_search";
import { connector as xUser } from "./x_user";
import { connector as youtube } from "./youtube";

/** The time limit of the `resolve` call of one connector. */
export const RESOLVE_TIMEOUT_MS = 12_000;

export const connectors: Record<SourceType, Connector> = {
  x_user: xUser,
  x_search: xSearch,
  podcast,
  blog,
  github,
  docs,
  newsletter,
  youtube,
  community,
  research,
  web_search: webSearch,
};

export function getConnector(type: SourceType): Connector {
  const connector = connectors[type];
  if (!connector) throw new Error(`unknown source type: ${String(type)}`);
  return connector;
}

/** Runs `resolve` of one connector. A failure or the time limit gives []. */
async function resolveWith(
  connector: Connector,
  input: string,
  ctx: ConnectorContext,
  forced: boolean,
  timeoutMs: number,
): Promise<Candidate[]> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  ctx.signal?.addEventListener("abort", stop, { once: true });
  if (ctx.signal?.aborted) controller.abort();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<Candidate[]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve([]);
    }, timeoutMs);
  });
  try {
    const work = connector
      .resolve(input, { ...ctx, signal: controller.signal }, forced)
      // When the person chose the type, only candidates of that type count.
      .then((found) => (forced ? found.filter((candidate) => candidate.type === connector.type) : found))
      .catch(() => [] as Candidate[]);
    return await Promise.race([work, limit]);
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", stop);
  }
}

/**
 * Turns one entry that a person typed into candidates: runs `resolve` of each
 * connector (or only the forced one) in parallel with a limit of 12 s for
 * each, merges the results, and sorts them by confidence (highest first).
 * A connector that fails or is too slow adds nothing.
 */
export async function resolveInput(
  input: string,
  ctx: ConnectorContext,
  forcedType?: SourceType,
  options: { timeoutMs?: number } = {},
): Promise<Candidate[]> {
  const entry = input.trim();
  if (!entry) return [];
  const types: readonly SourceType[] = forcedType ? [forcedType] : SOURCE_TYPES;
  const timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;

  const groups = await Promise.all(
    types.map((type) => resolveWith(getConnector(type), entry, ctx, forcedType === type, timeoutMs)),
  );

  return groups
    .flat()
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence || a.index - b.index)
    .map(({ candidate }) => candidate);
}
