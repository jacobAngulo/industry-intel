import type { NextConfig } from "next";

// The path prefix when the app is served below a sub-path (for example
// `/industry-intel` behind nginx). Set at build time only: Next.js inlines it
// into the client bundles. Empty (the default) serves the app at `/`.
const basePath = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  // `next/link` and `redirect()` add the base path themselves. A plain
  // `<form action>` does not: it reads NEXT_PUBLIC_BASE_PATH (see withBasePath).
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // Native or Node-only packages that the server must load with `require`
  // and not bundle. Add each new native package here.
  serverExternalPackages: ["better-sqlite3", "linkedom", "@mozilla/readability", "imapflow", "mailparser", "undici"],
  // Cache Components stay off. The app uses a synchronous SQLite driver, and
  // the root layout sets `dynamic = "force-dynamic"` for each page.
  // That option exists only when `cacheComponents` is off.
  cacheComponents: false,
};

export default nextConfig;
