// Comparison of two versions of a section or an entry.
import { normalizeForHash, sha } from "@/lib/text";

/** The hash of a text for comparison: case, punctuation, and spacing do not count (§6.3). */
export function contentHash(text: string): string {
  return sha(normalizeForHash(text));
}

/** The numbers of a normalized text, sorted, so that a moved number is not a change. */
function numbers(normalized: string): string {
  return (normalized.match(/\d+/g) ?? []).sort().join(" ");
}

const MAX_LCS_CELLS = 4_000_000;

/** The count of characters (not spaces) in the words that one text has and the other has not. */
export function changedCharacters(beforeNormalized: string, afterNormalized: string): number {
  const a = beforeNormalized === "" ? [] : beforeNormalized.split(" ");
  const b = afterNormalized === "" ? [] : afterNormalized.split(" ");
  // The common start and end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const length = (words: string[]) => words.reduce((sum, word) => sum + word.length, 0);
  if (midA.length === 0 || midB.length === 0) return length(midA) + length(midB);
  if (midA.length * midB.length > MAX_LCS_CELLS) return length(midA) + length(midB);

  // Longest common subsequence of words, weighted by the word length.
  const cols = midB.length + 1;
  let prev = new Uint32Array(cols);
  let curr = new Uint32Array(cols);
  for (let i = 1; i <= midA.length; i++) {
    const wordA = midA[i - 1]!;
    for (let j = 1; j <= midB.length; j++) {
      curr[j] = wordA === midB[j - 1] ? prev[j - 1]! + wordA.length : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[midB.length]!;
  return length(midA) + length(midB) - 2 * common;
}

/**
 * True when an edit is minor: fewer than 40 normalized characters differ and no number changed
 * (the ignoreMinorEdits rule of §6.3).
 */
export function isMinorEdit(before: string, after: string): boolean {
  const a = normalizeForHash(before);
  const b = normalizeForHash(after);
  if (a === b) return true;
  if (numbers(a) !== numbers(b)) return false;
  return changedCharacters(a, b) < 40;
}

function lineKey(line: string): string {
  return normalizeForHash(line.replace(/^\s*-\s+/, ""));
}

/** At most this many line keys for one snapshot section. */
export const MAX_LINE_KEYS = 600;

/** The short hash of a line key, as stored in the snapshot. */
function shortLineKey(key: string): string {
  return sha(key).slice(0, 12);
}

/**
 * The short hashes of the lines of a full text (unique, at most MAX_LINE_KEYS). The snapshot keeps
 * them for a text longer than its stored text, so that the lines after the cut are known.
 */
export function lineKeysOf(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const key = lineKey(line);
    if (key === "") continue;
    keys.add(shortLineKey(key));
    if (keys.size >= MAX_LINE_KEYS) break;
  }
  return [...keys];
}

/**
 * The new and changed parts of `blocks` against the old text: for each block with a line that the
 * old text did not have, the first line of the block (as context) and the new lines. Also the lines
 * of the old text that are gone. `oldLineKeys` (from lineKeysOf of the full old text) replaces the
 * lines of a cut old text for the test of a new line.
 */
export function changedParts(
  oldText: string,
  blocks: string[],
  oldLineKeys?: string[],
): { added: string[]; removed: string[] } {
  const oldKeys = new Set(oldText.split("\n").map(lineKey).filter((key) => key !== ""));
  const oldShort = oldLineKeys ? new Set(oldLineKeys) : null;
  const isOld = (key: string) => (oldShort ? oldShort.has(shortLineKey(key)) || oldKeys.has(key) : oldKeys.has(key));
  const newKeys = new Set<string>();
  const added: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const fresh = lines.filter((line) => {
      const key = lineKey(line);
      newKeys.add(key);
      return key !== "" && !isOld(key);
    });
    if (fresh.length === 0) continue;
    const head = lines[0]!;
    const out = fresh[0] === head ? fresh : [head, ...fresh];
    added.push(out.join("\n"));
  }
  const removed = oldText
    .split("\n")
    .filter((line) => {
      const key = lineKey(line);
      // With line keys, the last line of a cut old text is not a full line: it is not "removed".
      return key !== "" && !newKeys.has(key) && (oldShort === null || oldShort.has(shortLineKey(key)));
    })
    .map((line) => line.replace(/^\s*-\s+/, "").trim());
  return { added, removed };
}
