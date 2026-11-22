// The relay from the in-app feedback dialog to the Ticket Board intake API
// (/projects/ticket-board/docs/intake-integration.md). Server only. The
// browser never sees the Ticket Board address or the bearer token: it calls the
// Server Action submitFeedback, which calls this module.
//
// No Next.js import here, so the test can call it directly.
import { z } from "zod";

export const FEEDBACK_TITLE_MAX = 200;
export const FEEDBACK_DESCRIPTION_MAX = 5000;

export const feedbackSchema = z.object({
  kind: z.enum(["bug", "feature"], { error: "Choose a request type." }),
  title: z
    .string({ error: "Enter a summary." })
    .trim()
    .min(1, { error: "Enter a summary." })
    .max(FEEDBACK_TITLE_MAX, { error: `Use at most ${FEEDBACK_TITLE_MAX} characters.` }),
  description: z
    .string()
    .trim()
    .max(FEEDBACK_DESCRIPTION_MAX, { error: `Use at most ${FEEDBACK_DESCRIPTION_MAX} characters.` })
    .optional()
    .transform((value) => (value ? value : null)),
  /** A random id from the browser: a retry of the same submission does not make a second ticket. */
  submissionId: z.string().trim().min(8).max(200),
  /** The page where the person opened the dialog. */
  pageUrl: z.string().trim().max(2000).optional(),
  pageTitle: z.string().trim().max(300).optional(),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;

export type RelayResult =
  | { ok: true; identifier: string; duplicate: boolean }
  | { ok: false; reason: "not_configured" | "unavailable" | "rejected"; detail?: string };

export interface RelayEnv {
  [key: string]: string | undefined;
  TICKET_BOARD_INTAKE_TOKEN?: string;
  TICKET_BOARD_URL?: string;
  TICKET_BOARD_PROJECT_SLUG?: string;
}

const DEFAULT_BOARD_URL = "http://127.0.0.1:8040";
const DEFAULT_PROJECT_SLUG = "industry-intel";

/** Sends one submission to the Ticket Board intake API of the project. Never throws. */
export async function relayFeedback(
  input: FeedbackInput,
  requester: { name: string; userId: string },
  env: RelayEnv = process.env as RelayEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayResult> {
  const token = env.TICKET_BOARD_INTAKE_TOKEN?.trim();
  if (!token) return { ok: false, reason: "not_configured" };
  const boardUrl = (env.TICKET_BOARD_URL?.trim() || DEFAULT_BOARD_URL).replace(/\/+$/, "");
  const slug = env.TICKET_BOARD_PROJECT_SLUG?.trim() || DEFAULT_PROJECT_SLUG;

  const payload = {
    kind: input.kind,
    title: input.title,
    description: input.description,
    requester: {
      name: requester.name,
      contact: null,
      external_id: requester.userId,
    },
    source: {
      external_id: input.submissionId,
      url: input.pageUrl || null,
      context: { page_title: input.pageTitle || null, app: "industry-intel" },
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(`${boardUrl}/api/intake/${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return { ok: false, reason: "rejected", detail: typeof body.detail === "string" ? body.detail : undefined };
  }
  return {
    ok: true,
    identifier: typeof body.identifier === "string" ? body.identifier : "Your request",
    duplicate: body.duplicate === true,
  };
}
