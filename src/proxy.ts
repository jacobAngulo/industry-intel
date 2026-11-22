// The request interceptor of Next.js 16 (the old name was middleware.ts): one
// access check in front of everything (specification §15). Server Actions check
// again (withActor), because a matcher does not protect them by itself.
import { NextResponse, type NextRequest } from "next/server";

import { decideAccess } from "@/app/_lib/access-gate";
import { isAuthConfigured, sessionUserId } from "@/app/_lib/session";
import { getAccount } from "@/lib/services/users";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const configured = isAuthConfigured();
  const userId = configured ? await sessionUserId(request.headers) : null;
  const decision = decideAccess({
    path: pathname,
    search,
    method: request.method,
    configured,
    access: userId ? (getAccount(userId)?.access ?? null) : null,
  });
  switch (decision.kind) {
    case "allow":
      return NextResponse.next();
    case "redirect":
      return NextResponse.redirect(new URL(decision.to, request.url));
    case "deny":
      return new NextResponse(decision.status === 503 ? "Sign-in is not configured." : "Sign in to continue.", {
        status: decision.status,
      });
  }
}

export const config = {
  // Everything but the build output. A new path is closed until it is in the public list.
  matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"],
};
