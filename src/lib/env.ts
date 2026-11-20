// Typed, lazy access to the environment values (specification §11.4).
//
// - Each getter reads `process.env` at the time of the call, so an import of
//   this module reads nothing.
// - Never print a value. The getters are on the prototype, so
//   `console.log(env)` and `JSON.stringify(env)` show no value.
// - `has(name)` says only yes / no (for the status page).
import { resolveDatabasePathFrom } from "@/lib/db/path";

export const ENV_NAMES = [
  "OLLAMA_API_KEY",
  "OLLAMA_MODEL_JUDGE",
  "OLLAMA_MODEL_JUDGE_FALLBACK",
  "OLLAMA_MODEL_ANALYSIS",
  "OLLAMA_MODEL_ANALYSIS_FALLBACK",
  "OLLAMA_HOST",
  "LLM_MAX_CALLS_PER_DAY",
  "X_BEARER_TOKEN",
  "X_MAX_POSTS_PER_DAY",
  "WEB_SEARCH_MAX_PER_DAY",
  "GITHUB_TOKEN",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "IMAP_MAILBOX",
  "DATABASE_PATH",
  "PORT",
] as const;
export type EnvName = (typeof ENV_NAMES)[number];

/** Defaults of §11.4 and §20. */
export const ENV_DEFAULTS = {
  OLLAMA_MODEL_JUDGE: "deepseek-v4.1-flash",
  OLLAMA_MODEL_JUDGE_FALLBACK: "glm-5.3-flash",
  OLLAMA_MODEL_ANALYSIS: "glm-5.3",
  OLLAMA_MODEL_ANALYSIS_FALLBACK: "kimi-k3.1-pro",
  OLLAMA_HOST: "https://ollama.com",
  LLM_MAX_CALLS_PER_DAY: 1500,
  /** Fixed limit of the preview calls (not an environment value). */
  LLM_MAX_PREVIEW_CALLS_PER_DAY: 100,
  X_MAX_POSTS_PER_DAY: 300,
  WEB_SEARCH_MAX_PER_DAY: 50,
  IMAP_PORT: 993,
  IMAP_MAILBOX: "INBOX",
  PORT: 4400,
} as const;

export interface Env {
  /** The key of the Ollama cloud API. Undefined when it is not set. */
  readonly ollamaApiKey: string | undefined;
  readonly ollamaModelJudge: string;
  readonly ollamaModelJudgeFallback: string;
  readonly ollamaModelAnalysis: string;
  readonly ollamaModelAnalysisFallback: string;
  /** No trailing slash. Default https://ollama.com */
  readonly ollamaHost: string;
  readonly llmMaxCallsPerDay: number;
  readonly xBearerToken: string | undefined;
  readonly xMaxPostsPerDay: number;
  readonly webSearchMaxPerDay: number;
  readonly githubToken: string | undefined;
  readonly redditClientId: string | undefined;
  readonly redditClientSecret: string | undefined;
  readonly imapHost: string | undefined;
  readonly imapPort: number;
  readonly imapUser: string | undefined;
  readonly imapPassword: string | undefined;
  readonly imapMailbox: string;
  /** Absolute path of the SQLite file (the same rule as the database client). */
  readonly databasePath: string;
  readonly port: number;
  /** True when the variable has a value that is not empty. It never returns the value. */
  has(name: EnvName): boolean;
}

type EnvSource = Record<string, string | undefined>;

class LazyEnv implements Env {
  // A function, not the object: a test can change process.env after the import.
  readonly #source: () => EnvSource;

  constructor(source: () => EnvSource) {
    this.#source = source;
  }

  #text(name: EnvName): string | undefined {
    const value = this.#source()[name]?.trim();
    return value ? value : undefined;
  }

  /** A whole number that is not negative, else the default. */
  #count(name: EnvName, fallback: number): number {
    const value = this.#text(name);
    if (value === undefined || !/^\d+$/.test(value)) return fallback;
    return Number(value);
  }

  has(name: EnvName): boolean {
    return this.#text(name) !== undefined;
  }

  get ollamaApiKey() {
    return this.#text("OLLAMA_API_KEY");
  }
  get ollamaModelJudge() {
    return this.#text("OLLAMA_MODEL_JUDGE") ?? ENV_DEFAULTS.OLLAMA_MODEL_JUDGE;
  }
  get ollamaModelJudgeFallback() {
    return this.#text("OLLAMA_MODEL_JUDGE_FALLBACK") ?? ENV_DEFAULTS.OLLAMA_MODEL_JUDGE_FALLBACK;
  }
  get ollamaModelAnalysis() {
    return this.#text("OLLAMA_MODEL_ANALYSIS") ?? ENV_DEFAULTS.OLLAMA_MODEL_ANALYSIS;
  }
  get ollamaModelAnalysisFallback() {
    return this.#text("OLLAMA_MODEL_ANALYSIS_FALLBACK") ?? ENV_DEFAULTS.OLLAMA_MODEL_ANALYSIS_FALLBACK;
  }
  get ollamaHost() {
    return (this.#text("OLLAMA_HOST") ?? ENV_DEFAULTS.OLLAMA_HOST).replace(/\/+$/, "");
  }
  get llmMaxCallsPerDay() {
    return this.#count("LLM_MAX_CALLS_PER_DAY", ENV_DEFAULTS.LLM_MAX_CALLS_PER_DAY);
  }
  get xBearerToken() {
    return this.#text("X_BEARER_TOKEN");
  }
  get xMaxPostsPerDay() {
    return this.#count("X_MAX_POSTS_PER_DAY", ENV_DEFAULTS.X_MAX_POSTS_PER_DAY);
  }
  get webSearchMaxPerDay() {
    return this.#count("WEB_SEARCH_MAX_PER_DAY", ENV_DEFAULTS.WEB_SEARCH_MAX_PER_DAY);
  }
  get githubToken() {
    return this.#text("GITHUB_TOKEN");
  }
  get redditClientId() {
    return this.#text("REDDIT_CLIENT_ID");
  }
  get redditClientSecret() {
    return this.#text("REDDIT_CLIENT_SECRET");
  }
  get imapHost() {
    return this.#text("IMAP_HOST");
  }
  get imapPort() {
    return this.#count("IMAP_PORT", ENV_DEFAULTS.IMAP_PORT) || ENV_DEFAULTS.IMAP_PORT;
  }
  get imapUser() {
    return this.#text("IMAP_USER");
  }
  get imapPassword() {
    return this.#text("IMAP_PASSWORD");
  }
  get imapMailbox() {
    return this.#text("IMAP_MAILBOX") ?? ENV_DEFAULTS.IMAP_MAILBOX;
  }
  get databasePath() {
    return resolveDatabasePathFrom(this.#source().DATABASE_PATH);
  }
  get port() {
    return this.#count("PORT", ENV_DEFAULTS.PORT) || ENV_DEFAULTS.PORT;
  }
}

const processEnv: Env = new LazyEnv(() => process.env);

/** The environment of this process. Each getter reads process.env at the time of the call. */
export function getEnv(): Env {
  return processEnv;
}

/** An Env over the given values (tests, and code that must not read process.env). */
export function createEnv(values: Partial<Record<EnvName, string>>): Env {
  return new LazyEnv(() => values);
}

/** True when the model key is present. */
export function hasModelKey(env: Env = getEnv()): boolean {
  return env.has("OLLAMA_API_KEY");
}

/** True when the X API token is present. */
export function hasXToken(env: Env = getEnv()): boolean {
  return env.has("X_BEARER_TOKEN");
}

/** True when the dedicated mailbox is set (host, user, and password). */
export function hasMailbox(env: Env = getEnv()): boolean {
  return env.has("IMAP_HOST") && env.has("IMAP_USER") && env.has("IMAP_PASSWORD");
}
