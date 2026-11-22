import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNext } from "@/app/_lib/access-gate";
import { signInAction } from "@/app/_lib/auth-actions";
import { getSessionAccount } from "@/app/_lib/identity";
import { isAuthConfigured } from "@/app/_lib/session";
import { Banner, Card, PageContainer, SubmitButton } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeNext((await searchParams).next);
  // The proxy sends an account without access to the access request.
  if (await getSessionAccount()) redirect(next);

  return (
    <PageContainer>
      <Card className="mx-auto mt-10 flex max-w-md flex-col gap-5">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-fg">Industry Intel</h1>
          <p className="mt-2 text-sm text-muted">Sign in with Google. A new account then asks for access.</p>
        </div>
        {isAuthConfigured() ? (
          <form action={signInAction}>
            <input type="hidden" name="next" value={next} />
            <SubmitButton pendingLabel="Opening Google">Continue with Google</SubmitButton>
          </form>
        ) : (
          <Banner tone="warning">Sign-in is not set up on this server.</Banner>
        )}
      </Card>
    </PageContainer>
  );
}
