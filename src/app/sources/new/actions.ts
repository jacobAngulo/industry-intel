"use server";

// Server Actions of the add-source flow (specification §4.7, §18.1): one for
// each step, each with a typed object that zod validates. Nothing is stored
// before the last step.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { VALIDATION_MESSAGE, fail, ok, parseInput, withActor, zodFieldErrors } from "@/app/_lib/action-helpers";
import type { CreateStep, PreviewStep, ResolvedEntry, WizardCandidate } from "@/components/sources/wizard-logic";
import { parseConfig, sourceKey } from "@/lib/connectors/configs";
import {
  createFromWizard,
  getSource,
  previewSource,
  qualifyPreview,
  resolveEntries,
  serviceFailure,
  type ActionResult,
  type PreviewResult,
  type QualifyResult,
  type WizardCommon,
  type WizardEntry,
} from "@/lib/services";
import type { Priority, SourceType } from "@/lib/types";

import { createInput, previewInput, qualifyInput, resolveInput } from "../schemas";

/** The key of a config, or null when it is not valid for the type. */
function keyOrNull(type: SourceType, config: unknown): string | null {
  try {
    return sourceKey(type, parseConfig(type, config));
  } catch {
    return null;
  }
}

/** The config with the schema defaults, or the config as it came when it is not valid. */
function withDefaults(type: SourceType, config: unknown): unknown {
  try {
    return parseConfig(type, config);
  } catch {
    return config;
  }
}

/** Marks the candidate whose source is in the directory (resolveEntries names the first one only). */
async function markExisting(entries: WizardEntry[]): Promise<ResolvedEntry[]> {
  const keyOfSource = new Map<number, string | null>();
  for (const entry of entries) {
    if (entry.existing && !keyOfSource.has(entry.existing.id)) {
      const source = await getSource(entry.existing.id);
      keyOfSource.set(entry.existing.id, source ? keyOrNull(source.type, source.config) : null);
    }
  }
  return entries.map((entry) => {
    const existingKey = entry.existing ? (keyOfSource.get(entry.existing.id) ?? null) : null;
    let marked = false;
    const candidates: WizardCandidate[] = entry.candidates.map((candidate) => {
      const key = keyOrNull(candidate.type, candidate.config);
      const isExisting = entry.existing !== null && existingKey !== null && key === existingKey;
      if (isExisting) marked = true;
      return {
        ...candidate,
        config: withDefaults(candidate.type, candidate.config),
        existing: isExisting ? entry.existing : null,
      };
    });
    // The key of the stored source could not be read: mark the best candidate.
    if (entry.existing && !marked && candidates[0]) candidates[0] = { ...candidates[0], existing: entry.existing };
    return { input: entry.input, candidates, ...(entry.error ? { error: entry.error } : {}) };
  });
}

/** Step 1: the candidates for each entry. */
export async function resolveEntriesAction(input: {
  entries: string[];
  type?: SourceType | null;
}): Promise<ActionResult<ResolvedEntry[]>> {
  const parsed = parseInput(resolveInput, input);
  if (!parsed.ok) return parsed;
  try {
    const entries = await resolveEntries(parsed.data.entries, parsed.data.type ?? undefined);
    return ok(await markExisting(entries));
  } catch (error) {
    return serviceFailure(error);
  }
}


/** Step 2 to step 3: checks the configs with the schema of their type, then fetches recent items. */
export async function previewEntriesAction(input: {
  entries: Array<{ type: SourceType; name: string; url?: string; config: unknown }>;
  common: WizardCommon;
}): Promise<ActionResult<PreviewStep>> {
  const parsed = parseInput(previewInput, input);
  if (!parsed.ok) return parsed;
  const fieldErrors: Record<string, string> = {};
  const configs = parsed.data.entries.map((entry, index) => {
    try {
      return parseConfig(entry.type, entry.config);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      for (const [key, message] of Object.entries(zodFieldErrors(error))) {
        const path = key === "_form" ? `entries.${index}.config` : `entries.${index}.config.${key}`;
        if (!(path in fieldErrors)) fieldErrors[path] = message;
      }
      return null;
    }
  });
  if (Object.keys(fieldErrors).length > 0) return fail(VALIDATION_MESSAGE, "validation", fieldErrors);
  try {
    const preview = await previewSource(
      parsed.data.entries.map((entry, index) => ({ type: entry.type, name: entry.name, config: configs[index] })),
    );
    return ok({ configs, preview });
  } catch (error) {
    return serviceFailure(error);
  }
}

/** Step 3: would the recent items enter the selected feeds? */
export async function qualifyAction(input: {
  type: SourceType;
  sourceName: string;
  items: PreviewResult["entries"][number]["items"];
  config: unknown;
  feedIds: number[];
  follow: string;
  ignore: string;
  priority: Priority;
}): Promise<ActionResult<QualifyResult>> {
  const parsed = parseInput(qualifyInput, input);
  if (!parsed.ok) return parsed;
  try {
    return ok(await qualifyPreview(parsed.data));
  } catch (error) {
    return serviceFailure(error);
  }
}


/** Step 4: creates the sources, the feed links, the first check, and the backfill. */
export async function createSourcesAction(input: {
  entries: Array<{ type: SourceType; name: string; url?: string; config: unknown }>;
  common: WizardCommon;
}): Promise<ActionResult<CreateStep>> {
  const parsed = parseInput(createInput, input);
  if (!parsed.ok) return parsed;
  return withActor({ needsName: true }, async (actor) => {
    try {
      const entries = parsed.data.entries.map((entry) => {
        const url = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : undefined;
        return { type: entry.type, name: entry.name, config: entry.config, ...(url ? { url } : {}) };
      });
      const result = await createFromWizard({ entries, common: parsed.data.common }, actor);
      revalidatePath("/sources");
      revalidatePath("/", "layout");
      return ok(result);
    } catch (error) {
      return serviceFailure(error);
    }
  });
}
