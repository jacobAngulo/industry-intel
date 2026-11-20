// The request interceptor of Next.js 16 (the old name was middleware.ts).
// Identity (specification §15): each browser gets the cookie `ii_client`, a
// random UUID. It is not security: there is no login.
import { NextResponse, type NextRequest } from "next/server";

import {
  CLIENT_COOKIE,
  CLIENT_HEADER,
  COOKIE_MAX_AGE_SECONDS,
  isValidClientId,
} from "@/app/_lib/identity-constants";

export function proxy(request: NextRequest) {
  const existing = request.cookies.get(CLIENT_COOKIE)?.value;
  const clientId = isValidClientId(existing) ? existing : crypto.randomUUID();

  // Always overwrite the header, so that a browser cannot send its own value.
  const headers = new Headers(request.headers);
  headers.set(CLIENT_HEADER, clientId);
  const response = NextResponse.next({ request: { headers } });

  if (clientId !== existing) {
    response.cookies.set({
      name: CLIENT_COOKIE,
      value: clientId,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}

export const config = {
  // Pages and Server Actions. Not the static files, the image optimizer, the
  // icons, or the API routes (they need no identity).
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|icon|apple-icon|robots.txt|sitemap.xml).*)"],
};
