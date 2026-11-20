// The cost line of the x_search connector for the add-source wizard (§6.3).
// Pure: no import with Node-only code, so a client component can use it.
import type { XSearchConfig } from "../configs";

const PRICE_PER_POST_USD = 0.005;
const DEFAULT_MAX_POSTS_PER_DAY = 300;

function usd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "less than $0.01";
  return `$${amount.toFixed(2)}`;
}

function runsPerDay(intervalMinutes: number): number {
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 720;
  return Math.round((1440 / interval) * 10) / 10;
}

/**
 * The cost line for one X keyword, for example
 * "Each run reads up to 20 posts. At 2 runs each day that is up to 40 post reads (about $0.20) for this keyword.
 *  The app stops at X_MAX_POSTS_PER_DAY (300 post reads each day)."
 */
export function costNote(
  config: Pick<XSearchConfig, "maxPostsPerRun">,
  intervalMinutes: number,
  opts: { maxPostsPerDay?: number } = {},
): string {
  const perRun = Math.min(100, Math.max(10, Math.floor(config.maxPostsPerRun || 20)));
  const runs = runsPerDay(intervalMinutes);
  const reads = Math.round(perRun * runs);
  const cap = opts.maxPostsPerDay ?? DEFAULT_MAX_POSTS_PER_DAY;
  const runsText = Number.isInteger(runs) ? `${runs} run${runs === 1 ? "" : "s"}` : `about ${runs} runs`;
  return (
    `Each run reads up to ${perRun} posts. At ${runsText} each day that is up to ${reads} post reads ` +
    `(about ${usd(reads * PRICE_PER_POST_USD)}) for this keyword. ` +
    `The app stops at X_MAX_POSTS_PER_DAY (${cap} post reads each day).`
  );
}
