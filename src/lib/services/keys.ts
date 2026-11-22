// Saved API keys (settings page, section "API keys"). The keys go to the
// settings row `api_keys`; getEnv() reads them in each process (see env.ts).
// Nothing here returns, logs, or puts a key value into an error.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { STORED_KEY_NAMES, STORED_KEYS_SETTING, readStoredKeys, type StoredKeyName } from "@/lib/env";
import { clearLlmPause } from "@/lib/pipeline/jobs";

import { inImmediate, writeSetting } from "./_manage-db";
import { parseOrThrow } from "./_manage-errors";
import { logActivity } from "./activity";
import type { Actor } from "./types";

export const STORED_KEY_LABELS: Record<StoredKeyName, string> = {
  OLLAMA_API_KEY: "Ollama API key",
  X_BEARER_TOKEN: "X bearer token",
};

/** Where the process gets the key from. A saved key wins over .env. */
export type KeySource = "saved" | "env" | "missing";

export interface KeyStatus {
  name: StoredKeyName;
  label: string;
  source: KeySource;
  /** True when .env also has the variable (it is used again after "Remove"). */
  inEnvFile: boolean;
  /** The time and the person of the last save of the row (null when no key is saved). */
  savedAt: number | null;
  savedBy: string | null;
}

export const KEY_VALUE_MAX_LENGTH = 1000;

export const storedKeyNameSchema = z.enum(STORED_KEY_NAMES);

/** Printable ASCII, no spaces: a key goes into an HTTP header. */
export const storedKeyValueSchema = z
  .string()
  .trim()
  .min(1, "Enter the key.")
  .max(KEY_VALUE_MAX_LENGTH, `At most ${KEY_VALUE_MAX_LENGTH} characters.`)
  .regex(/^[\x21-\x7E]+$/, "A key has no spaces and only plain characters (ASCII).");

function readRow(): { value: Record<string, unknown>; updatedAt: number; updatedBy: string } | null {
  const row = getDb()
    .select({ value: settings.value, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(eq(settings.key, STORED_KEYS_SETTING))
    .get();
  if (!row) return null;
  const value = row.value && typeof row.value === "object" ? (row.value as Record<string, unknown>) : {};
  return { value, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

/** Yes / no facts only: never the value. */
export async function getKeyStatuses(): Promise<KeyStatus[]> {
  getDb(); // opens the database, so that readStoredKeys() can read it
  const stored = readStoredKeys();
  const row = readRow();
  return STORED_KEY_NAMES.map((name) => {
    const inEnvFile = (process.env[name]?.trim() ?? "") !== "";
    const saved = stored[name] !== undefined;
    return {
      name,
      label: STORED_KEY_LABELS[name],
      source: saved ? "saved" : inEnvFile ? "env" : "missing",
      inEnvFile,
      savedAt: saved && row ? row.updatedAt : null,
      savedBy: saved && row ? row.updatedBy || null : null,
    };
  });
}

function writeKey(name: StoredKeyName, value: string | null, actor: Actor): void {
  const by = actor.name.trim();
  inImmediate(() => {
    const current = { ...(readRow()?.value ?? {}) };
    if (value === null) delete current[name];
    else current[name] = value;
    writeSetting(STORED_KEYS_SETTING, current, by);
    const label = STORED_KEY_LABELS[name];
    logActivity(actor, "settings.api_key", "settings", null, value === null ? `Removed the saved ${label}.` : `Saved the ${label}.`);
  });
  // A pause from a refused or missing model key must not hold the new key back.
  if (name === "OLLAMA_API_KEY") clearLlmPause();
}

export async function saveStoredKey(input: { name: StoredKeyName; value: string }, actor: Actor): Promise<void> {
  const data = parseOrThrow(z.object({ name: storedKeyNameSchema, value: storedKeyValueSchema }), input);
  writeKey(data.name, data.value, actor);
}

export async function removeStoredKey(input: { name: StoredKeyName }, actor: Actor): Promise<void> {
  const data = parseOrThrow(z.object({ name: storedKeyNameSchema }), input);
  writeKey(data.name, null, actor);
}
