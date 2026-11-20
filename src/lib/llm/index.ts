// The model module (specification §11.3 and §20): the provider for the Ollama
// cloud API, its web search, and the scripted FakeLlm for tests.
import type { UsageMeter } from "@/lib/connectors/types";
import type { Env } from "@/lib/env";
import type { SafeHttp } from "@/lib/http/types";

import { OllamaLlm, type LlmLog } from "./ollama";
import type { LlmProvider, WebSearchProvider } from "./types";
import { OllamaWebSearch } from "./web-search";

export * from "./types";
export { FakeLlm } from "./fake";
export type { FakeLlmCall, FakeLlmHandler, FakeLlmOptions, FakeLlmReply } from "./fake";
export { OllamaLlm, chooseThink, parseShow, type LlmLog, type ThinkInfo, type ThinkValue } from "./ollama";
export { OllamaWebSearch } from "./web-search";

export interface LlmDeps {
  http: SafeHttp;
  usage: UsageMeter;
  env: Env;
  /** Default: logEvent. Used for the warn event of a switch to the fallback model. */
  log?: LlmLog;
}

/**
 * The Ollama cloud provider. available() is false with no key, and json()
 * then throws kind `no_key` with no HTTP call. Build it one time for each
 * process: the switch to a fallback model and the think facts of each model
 * live in the instance.
 */
export function getLlm(deps: LlmDeps): LlmProvider {
  return new OllamaLlm(deps);
}

/** The web search of the Ollama cloud API, or null when the key is missing. */
export function getWebSearch(deps: LlmDeps): WebSearchProvider | null {
  if (deps.env.ollamaApiKey === undefined) return null;
  return new OllamaWebSearch(deps);
}
