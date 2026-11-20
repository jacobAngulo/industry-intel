// The real dependencies of the pipeline, built one time for each process
// (specification §11.5).
import type { UsageMeter } from "@/lib/connectors/types";
import { getEnv, type Env } from "@/lib/env";
import { createSafeHttp } from "@/lib/http";
import { getLlm } from "@/lib/llm";
import { OllamaWebSearch } from "@/lib/llm/web-search";
import { createMailReader } from "@/lib/mail";
import type { PipelineDeps } from "@/lib/pipeline";
import { nowMs } from "@/lib/time";
import { createUsageMeter } from "@/lib/usage";

export type Deps = PipelineDeps & { usage: UsageMeter; env: Env };

// On globalThis, so that the hot reload of the Next.js dev server and all
// bundles of one process share the same objects (the HTTP client keeps
// per-host limits; the model provider keeps its fallback state).
const globalForDeps = globalThis as typeof globalThis & { __industryIntelDeps?: Deps };

function buildDeps(): Deps {
  const env = getEnv();
  const http = createSafeHttp();
  const usage = createUsageMeter(env);
  const webSearch = new OllamaWebSearch({ http, usage, env });
  return {
    env,
    http,
    usage,
    llm: getLlm({ http, usage, env }),
    // A getter: the key can be saved on the settings page after the start (null with no key, §11.5).
    get search() {
      return env.ollamaApiKey === undefined ? null : webSearch;
    },
    mail: createMailReader(env),
    now: nowMs,
  };
}

/** The dependencies of this process. The first call builds them. It opens no connection. */
export function getDeps(): Deps {
  globalForDeps.__industryIntelDeps ??= buildDeps();
  return globalForDeps.__industryIntelDeps;
}

/** Tests: replaces the dependencies of the process (`null` = build them again at the next call). */
export function setDepsForTests(deps: Deps | null): void {
  globalForDeps.__industryIntelDeps = deps ?? undefined;
}
