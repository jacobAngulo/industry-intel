import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { getActor } from "@/app/_lib/identity";
import { Banners } from "@/components/Banners";
import { FeedbackButton } from "@/components/FeedbackButton";
import { TopNav, type FeedTab } from "@/components/nav";
import { getBanners, listFeeds, type AppBanner } from "@/lib/services";

import "./globals.css";

// Each page of the app reads SQLite at request time. This option stops the
// static prerender for all pages below the root layout.
// A route handler (route.ts) is not below a layout: it sets the option itself.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Industry Intel", template: "%s · Industry Intel" },
  description: "AI-curated industry intelligence.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf8" },
    { media: "(prefers-color-scheme: dark)", color: "#141413" },
  ],
};

/** The data of the page shell. A failure here must not hide the page: the page shows its own error. */
async function loadShell(): Promise<{ feeds: FeedTab[]; banners: AppBanner[]; name: string | null }> {
  const [feeds, banners, actor] = await Promise.all([
    listFeeds().catch((error: unknown) => {
      console.error("layout: listFeeds failed", error instanceof Error ? error.message : error);
      return [];
    }),
    getBanners().catch((error: unknown) => {
      console.error("layout: getBanners failed", error instanceof Error ? error.message : error);
      return [];
    }),
    getActor(),
  ]);
  return {
    feeds: feeds
      .filter((f) => !f.archived)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((f) => ({ slug: f.slug, name: f.name, alertIds: f.alertIds })),
    // Every page shows only the worker banner here; feed pages show their own banners.
    banners: banners.filter((b) => b.kind === "worker_down"),
    name: actor.name,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const shell = await loadShell();
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-bg font-sans text-fg antialiased">
        <a
          href="#main"
          className="sr-only z-50 rounded-control bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <TopNav feeds={shell.feeds} name={shell.name} />
        {shell.banners.length > 0 ? (
          <div className="mx-auto w-full max-w-[1120px] px-4 pt-3 sm:px-6">
            <Banners banners={shell.banners} density="thin" />
          </div>
        ) : null}
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
        <footer className="mt-16 border-t border-border">
          <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-2 gap-y-1 px-4 py-5 text-sm text-muted sm:px-6">
            <span>Industry Intel · shared, no login.</span>
            <Link href="/activity" className="text-muted underline hover:text-fg">
              Recent changes
            </Link>
            <span aria-hidden="true">·</span>
            <FeedbackButton />
          </div>
        </footer>
      </body>
    </html>
  );
}
