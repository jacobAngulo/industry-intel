// Builds the context that each connector call gets (specification §6.2).
import { getEnv, type Env } from "@/lib/env";
import type { SafeHttp } from "@/lib/http/types";
import type { WebSearchProvider } from "@/lib/llm/types";
import { createUsageMeter } from "@/lib/usage";

import type { ConnectorContext, MailReader, UsageMeter } from "./types";

export interface ConnectorContextDeps {
  http: SafeHttp;
  search: WebSearchProvider | null;
  mail: MailReader | null;
  now: () => number;
  /** Default: the environment of the process. */
  env?: Env;
  /** Default: the meter over the table usage_daily. */
  usage?: UsageMeter;
  signal?: AbortSignal;
}

export function createConnectorContext(deps: ConnectorContextDeps): ConnectorContext {
  const env = deps.env ?? getEnv();
  return {
    http: deps.http,
    env,
    now: deps.now,
    usage: deps.usage ?? createUsageMeter(env),
    search: deps.search,
    mail: deps.mail,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}
