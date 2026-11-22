/** True when `pathname` is `href` or below it ("/f/a" matches "/f/a/story/1", not "/f/ab"). */
export function pathMatches(pathname: string, href: string, match: "exact" | "prefix" = "prefix"): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  if (pathname === path) return true;
  if (match === "exact" || path === "/") return false;
  const base = path.endsWith("/") ? path : `${path}/`;
  return pathname.startsWith(base);
}
