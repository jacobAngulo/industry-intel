"use server";

// Sign-in and sign-out (specification §15). They need no access: a person
// without access must be able to use them.
import { signIn, signOut } from "@/auth";

import { safeNext } from "./access-gate";

export async function signInAction(formData: FormData): Promise<void> {
  const next = formData.get("next");
  await signIn("google", { redirectTo: safeNext(typeof next === "string" ? next : undefined) });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
