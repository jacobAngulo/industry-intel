// The claim of the judge stage (§7.3): pending items that are safe to judge
// now. Two related items in flight at the same time could each create a
// story for the same event, so a related item waits for the next round.
import { getSqlite } from "@/lib/db/client";
import { isRootUrl, significantWords } from "@/lib/text";
import { MINUTE_MS } from "@/lib/time";

export const JUDGE_LOCK_MS = 3 * MINUTE_MS;
/** How many pending items one claim looks at to find `limit` safe ones. */
const SCAN_LIMIT = 200;

interface ClaimInfo {
  id: number;
  canonicalUrl: string | null;
  links: Set<string>;
  words: string[];
}

function infoRows(sql: string, params: Record<string, unknown>): ClaimInfo[] {
  const rows = getSqlite().prepare(sql).all(params) as Array<{
    id: number;
    canonical_url: string | null;
    title: string;
    links: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    canonicalUrl: row.canonical_url && !isRootUrl(row.canonical_url) ? row.canonical_url : null,
    links: new Set(row.links ? (JSON.parse(row.links) as string[]) : []),
    words: significantWords(row.title),
  }));
}

const INFO_COLUMNS = `i.id, i.canonical_url, i.title,
  (SELECT json_group_array(l.url) FROM item_links l WHERE l.item_id = i.id) AS links`;

/** At least half of the significant title words in common (of the shorter title), and at least 2. */
function similarTitles(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const other = new Set(b);
  const common = a.filter((word) => other.has(word)).length;
  return common >= 2 && common * 2 >= Math.min(a.length, b.length);
}

/** The same canonical URL, a link relation in either direction, or similar titles. */
function areRelated(a: ClaimInfo, b: ClaimInfo): boolean {
  if (a.canonicalUrl !== null && a.canonicalUrl === b.canonicalUrl) return true;
  if (a.canonicalUrl !== null && b.links.has(a.canonicalUrl)) return true;
  if (b.canonicalUrl !== null && a.links.has(b.canonicalUrl)) return true;
  return similarTitles(a.words, b.words);
}

/** Claims up to `limit` pending items that are safe to judge now (§7.3 claim rules) and returns their ids. */
export function claimItemsToJudge(limit: number, inFlightItemIds: number[], now: number): number[] {
  if (limit <= 0) return [];
  const sqlite = getSqlite();
  return sqlite
    .transaction(() => {
      const busy = infoRows(`SELECT ${INFO_COLUMNS} FROM items i WHERE i.id IN (SELECT value FROM json_each(@ids))`, {
        ids: JSON.stringify(inFlightItemIds),
      });
      const candidates = infoRows(
        `SELECT ${INFO_COLUMNS} FROM items i
          WHERE i.judge_status = 'pending'
            AND (i.next_judge_at IS NULL OR i.next_judge_at <= @now)
            AND (i.judge_locked_until IS NULL OR i.judge_locked_until < @now)
            AND i.id NOT IN (SELECT value FROM json_each(@ids))
          ORDER BY i.fetched_at, i.id
          LIMIT @scan`,
        { now, ids: JSON.stringify(inFlightItemIds), scan: SCAN_LIMIT },
      );

      const picked: ClaimInfo[] = [];
      for (const candidate of candidates) {
        if (picked.length >= limit) break;
        if (busy.some((other) => areRelated(candidate, other))) continue;
        if (picked.some((other) => areRelated(candidate, other))) continue;
        picked.push(candidate);
      }
      const lock = sqlite.prepare("UPDATE items SET judge_locked_until = ? WHERE id = ?");
      for (const item of picked) lock.run(now + JUDGE_LOCK_MS, item.id);
      return picked.map((item) => item.id);
    })
    .immediate();
}
