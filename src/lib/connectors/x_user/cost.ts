// The cost line of the x_user connector for the add-source wizard (§6.3).
// Pure: no import with Node-only code, so a client component can use it.
import type { XUserConfig } from "../configs";

const PRICE_PER_POST_USD = 0.005;
const PRICE_PER_USER_USD = 0.01;
const DEFAULT_MAX_POSTS_PER_DAY = 300;

function usd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "less than $0.01";
  return `$${amount.toFixed(2)}`;
}

/**
 * The cost line for one X user, for example
 * "Each post that the app reads costs money at X (about $0.005). This account: about 12 posts each day (about $0.06)."
 *
 * The app reads only the posts that are new since the last check, so the
 * cost follows how often the account posts, not the check interval. When
 * `postsPerDay` is not known (finding it needs a paid call), the line names
 * the first check and the daily cap instead.
 */
export function costNote(
  config: Pick<XUserConfig, "username">,
  intervalMinutes: number,
  opts: { postsPerDay?: number; maxPostsPerDay?: number } = {},
): string {
  const cap = opts.maxPostsPerDay ?? DEFAULT_MAX_POSTS_PER_DAY;
  const handle = config.username ? `@${config.username.replace(/^@+/, "")}` : "this account";
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.round(intervalMinutes) : 60;
  const head = `Each post that the app reads costs money at X (about $${PRICE_PER_POST_USD}).`;
  const first = `The first check reads the 5 newest posts and looks up the account (about ${usd(5 * PRICE_PER_POST_USD + PRICE_PER_USER_USD)}).`;
  const tail = `The app checks every ${interval} minutes, reads only new posts, and stops at X_MAX_POSTS_PER_DAY (${cap} post reads each day).`;
  if (opts.postsPerDay !== undefined && Number.isFinite(opts.postsPerDay) && opts.postsPerDay >= 0) {
    const n = Math.round(opts.postsPerDay);
    return `${head} This account: about ${n} posts each day (about ${usd(n * PRICE_PER_POST_USD)} each day). ${tail}`;
  }
  return `${head} The cost follows how often ${handle} posts: at 10 posts each day, about ${usd(10 * PRICE_PER_POST_USD)} each day. ${first} ${tail}`;
}
