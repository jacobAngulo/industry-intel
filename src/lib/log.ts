// The event log: one console line and one `events` row for each event.
// Never put a secret or a full item text into the message or the data.
import { getDb } from "@/lib/db/client";
import { events } from "@/lib/db/schema";
import { nowMs } from "@/lib/time";
import type { EventLevel } from "@/lib/types";

const MAX_MESSAGE = 500;
const MAX_SCOPE = 60;
const MAX_DATA_JSON = 2000;

function safeData(data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null;
  try {
    const json = JSON.stringify(data);
    if (json === undefined) return null;
    if (json.length <= MAX_DATA_JSON) return JSON.parse(json) as Record<string, unknown>;
    return { truncated: json.slice(0, MAX_DATA_JSON) };
  } catch {
    return { note: "The event data was not serializable." };
  }
}

/**
 * Writes one console line and one row of the `events` table.
 * A failure to write the row does not throw (the console line still shows).
 */
export function logEvent(level: EventLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  const at = nowMs();
  const text = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
  const cleanScope = scope.slice(0, MAX_SCOPE);
  const cleanData = safeData(data);

  const line = `[${new Date(at).toISOString()}] ${level.toUpperCase()} ${cleanScope}: ${text}${
    cleanData ? ` ${JSON.stringify(cleanData)}` : ""
  }`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  try {
    getDb().insert(events).values({ at, level, scope: cleanScope, message: text, data: cleanData }).run();
  } catch (error) {
    try {
      console.error(
        `[log] The event row was not written: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
      );
    } catch {
      /* nothing more to do */
    }
  }
}
