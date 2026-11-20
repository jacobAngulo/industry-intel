// Finds the JSON value in a model reply. A model can put the object in a
// code fence, or write a sentence before or after it (specification §20).

export type ExtractResult = { ok: true; value: unknown } | { ok: false; error: string };

/** The most object starts that the scan tries (a guard against a reply with thousands of braces). */
const MAX_CANDIDATES = 50;

function tryParse(text: string): ExtractResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The text is not JSON." };
  }
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * The index of the brace that closes the object that starts at `start`, or -1
 * when the object has no end. Braces inside a JSON string do not count.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The first balanced `{ ... }` in the text that is valid JSON. */
function firstBalancedObject(text: string): ExtractResult {
  let lastError = "The reply has no JSON object.";
  let from = 0;
  for (let tries = 0; tries < MAX_CANDIDATES; tries += 1) {
    const start = text.indexOf("{", from);
    if (start === -1) break;
    const end = balancedEnd(text, start);
    if (end === -1) {
      // No object can start later and close: the text after `start` has more "{" than "}".
      // Still try the next start: a brace in the prose can be the cause.
      lastError = "The JSON object in the reply is not complete.";
      from = start + 1;
      continue;
    }
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed.ok && isObject(parsed.value)) return parsed;
    if (!parsed.ok) lastError = `The reply is not valid JSON: ${parsed.error}`;
    from = start + 1;
  }
  return { ok: false, error: lastError };
}

/**
 * Reads the JSON value of a model reply. The order:
 * 1. the full text, when it is JSON;
 * 2. the content of a code fence (```json ... ``` or ``` ... ```);
 * 3. the first balanced object in the text.
 * It does not validate the shape: the zod schema of the caller does that.
 */
export function extractJsonValue(reply: string): ExtractResult {
  const text = reply
    .replace(/^﻿/, "")
    // Some models write their thinking into the content. It is never JSON that the caller wants.
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .trim();
  if (text === "") return { ok: false, error: "The reply is empty." };

  if (text.startsWith("{") || text.startsWith("[")) {
    const whole = tryParse(text);
    if (whole.ok) return whole;
  }

  const fence = /```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    const inner = (match[1] ?? "").trim();
    if (inner === "") continue;
    const whole = tryParse(inner);
    if (whole.ok && isObject(whole.value)) return whole;
    const part = firstBalancedObject(inner);
    if (part.ok) return part;
  }

  return firstBalancedObject(text);
}
