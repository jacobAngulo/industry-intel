// Auth.js: Google sign-in with a signed JWT cookie (specification §15).
// Signing in proves an identity only. The access comes from the database on
// each request (src/app/_lib/identity.ts, src/proxy.ts).
//
// The config is a function, so `next build` needs no environment.
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { SESSION_MAX_AGE_SECONDS, secureCookies } from "@/app/_lib/session";
import { recordSignIn } from "@/lib/services/users";

export const { handlers, signIn, signOut } = NextAuth(() => ({
  providers: [Google],
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login", error: "/auth/error" },
  trustHost: true,
  useSecureCookies: secureCookies(),
  callbacks: {
    // Only an email that Google verified can be shown to the operator as proof of who asks.
    signIn({ account, profile }) {
      return account?.provider === "google" && profile?.email_verified === true && Boolean(profile.email);
    },
    // `account` and `profile` exist only at sign-in. Without a database adapter
    // `user.id` is random at each sign-in, so the subject is the Google account id.
    jwt({ token, account, profile }) {
      if (account && profile?.email) {
        recordSignIn({
          id: account.providerAccountId,
          email: profile.email,
          name: profile.name,
          image: typeof profile.picture === "string" ? profile.picture : null,
        });
        return { sub: account.providerAccountId };
      }
      return token;
    },
  },
}));
