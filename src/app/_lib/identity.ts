// Identity of the person who makes a request (specification §15). Server only.
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAccount, type Account } from "@/lib/services/users";

import { ACCESS_PATH } from "./access-gate";
import { isAuthConfigured, sessionUserId } from "./session";

/** The signed-in account, with or without access, or null. */
export const getSessionAccount = cache(async (): Promise<Account | null> => {
  if (!isAuthConfigured()) return null;
  const id = await sessionUserId(await headers());
  return id ? getAccount(id) : null;
});

/** The account when it can use the app, or null. */
export async function getUser(): Promise<Account | null> {
  const account = await getSessionAccount();
  return account?.access === "approved" ? account : null;
}

/** For a page: the account, or a redirect to the sign-in or the access request. */
export async function requireUser(): Promise<Account> {
  const account = await getSessionAccount();
  if (!account) redirect("/login");
  if (account.access !== "approved") redirect(ACCESS_PATH);
  return account;
}
