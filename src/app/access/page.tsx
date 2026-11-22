import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { signOutAction } from "@/app/_lib/auth-actions";
import { getSessionAccount } from "@/app/_lib/identity";
import { Button, Card, PageContainer } from "@/components/ui";
import { ACCESS_NOTE_MAX } from "@/lib/services";

import { AccessRequestForm } from "./AccessRequestForm";

export const metadata: Metadata = { title: "Access" };

const TEXT = {
  none: { title: "Request access", body: "Industry Intel is private. Send a request, and the operator decides." },
  pending: { title: "Your request is waiting", body: "The operator has your request. Reload this page after the approval." },
  denied: { title: "Your request was not approved", body: "You can send a new request." },
} as const;

/** The only page for a signed-in account that has no access. */
export default async function AccessPage() {
  const account = await getSessionAccount();
  if (!account) redirect("/login");
  if (account.access === "approved") redirect("/");
  const text = TEXT[account.access];

  return (
    <PageContainer>
      <Card className="mx-auto mt-10 flex max-w-md flex-col gap-5">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-fg">{text.title}</h1>
          <p className="mt-2 text-sm text-muted">{text.body}</p>
          <p className="mt-2 text-sm text-muted">Signed in as {account.email}.</p>
        </div>
        {account.access === "pending" ? null : (
          <AccessRequestForm maxLength={ACCESS_NOTE_MAX} label={account.access === "denied" ? "Send a new request" : "Request access"} />
        )}
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </Card>
    </PageContainer>
  );
}
