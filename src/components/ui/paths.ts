/** True when `pathname` is `href` or below it ("/f/a" matches "/f/a/story/1", not "/f/ab"). */
export function pathMatches(pathname: string, href: string, match: "exact" | "prefix" = "prefix"): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  if (pathname === path) return true;
  if (match === "exact" || path === "/") return false;
  const base = path.endsWith("/") ? path : `${path}/`;
  return pathname.startsWith(base);
}

/**
 * `path` with the build-time base path in front, for the places that Next.js
 * does not prefix itself (a plain `<form action>`). `next/link` and
 * `redirect()` need no help.
 */
export function withBasePath(path: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}
