// The one access decision for every request (specification §15). Pure: the
// proxy gives it the facts. A path that is not in the short public list is closed.
import type { AccessStatus } from "@/lib/services/users";

const PUBLIC_PATHS: readonly string[] = ["/login", "/auth/error", "/api/health"];
/** /api/admin checks its own bearer token. */
const PUBLIC_PREFIXES: readonly string[] = ["/api/auth/", "/api/admin/"];

export const ACCESS_PATH = "/access";

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.includes(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface GateFacts {
  path: string;
  /** With the leading "?", or "". */
  search: string;
  method: string;
  configured: boolean;
  /** null = not signed in, or the account does not exist. */
  access: AccessStatus | null;
}

export type GateDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string }
  | { kind: "deny"; status: 401 | 403 | 503 };

export function decideAccess({ path, search, method, configured, access }: GateFacts): GateDecision {
  if (isPublicPath(path)) return { kind: "allow" };
  if (!configured) return { kind: "deny", status: 503 };
  // A redirect makes sense for a page only. A Server Action is a POST.
  const isPage = (method === "GET" || method === "HEAD") && !path.startsWith("/api/");
  if (access === null) {
    if (!isPage) return { kind: "deny", status: 401 };
    const next = path === "/" ? "" : `?next=${encodeURIComponent(path + search)}`;
    return { kind: "redirect", to: `/login${next}` };
  }
  if (access === "approved") return path === ACCESS_PATH && isPage ? { kind: "redirect", to: "/" } : { kind: "allow" };
  if (path === ACCESS_PATH) return { kind: "allow" };
  return isPage ? { kind: "redirect", to: ACCESS_PATH } : { kind: "deny", status: 403 };
}

/** The page to open after the sign-in: a path of this site, or "/". */
export function safeNext(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^\/(?![/\\])/.test(value) || /[\u0000-\u001f\\]/.test(value)) return "/";
  return isPublicPath(value.split(/[?#]/)[0]!) ? "/" : value;
}
