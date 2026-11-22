import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native or Node-only packages that the server must load with `require`
  // and not bundle. Add each new native package here.
  serverExternalPackages: ["better-sqlite3", "linkedom", "@mozilla/readability", "imapflow", "mailparser", "undici"],
  // Cache Components stay off. The app uses a synchronous SQLite driver, and
  // the root layout sets `dynamic = "force-dynamic"` for each page.
  // That option exists only when `cacheComponents` is off.
  cacheComponents: false,
};

export default nextConfig;
