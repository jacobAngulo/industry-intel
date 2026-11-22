import type { Metadata } from "next";

import { Card, LinkButton, PageContainer } from "@/components/ui";

export const metadata: Metadata = { title: "Sign-in failed" };

export default function AuthErrorPage() {
  return (
    <PageContainer>
      <Card className="mx-auto mt-10 flex max-w-md flex-col gap-4">
        <h1 className="font-serif text-2xl font-semibold text-fg">The sign-in did not work</h1>
        <p className="text-sm text-muted">
          Use a Google account with a verified email address, then try again. No account was changed.
        </p>
        <div>
          <LinkButton href="/login" variant="primary">
            Back to sign-in
          </LinkButton>
        </div>
      </Card>
    </PageContainer>
  );
}
