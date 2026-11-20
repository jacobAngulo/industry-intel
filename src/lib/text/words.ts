import { createHash } from "node:crypto";

/**
 * Characters that a reader cannot see: control characters (not newline, not tab), the soft hyphen,
 * zero-width characters, the byte order mark, bidirectional controls, invisible fillers, and the
 * Unicode tag characters. The pattern is built from a string so that the source file holds no
 * control character.
 */
const INVISIBLE = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F" + // C0 and C1 controls
    "\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E" +
    "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F" +
    "\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB" +
    "\\u{E0000}-\\u{E007F}" +
    "]",
  "gu",
);

/** Removes invisible characters. "\r\n" and "\r" become "\n". Newline and tab stay. */
export function stripInvisible(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "");
}

/** At most `n` characters. A cut text ends with "…" and, when a word border is near, at that border. */
export function truncate(text: string, n: number): string {
  if (typeof text !== "string" || n <= 0) return "";
  if (text.length <= n) return text;
  if (n === 1) return "…";
  let cut = n - 1;
  const before = text.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) cut -= 1; // do not cut a surrogate pair in two
  let head = text.slice(0, cut);
  const next = text.charAt(cut);
  if (next !== "" && !/\s/.test(next) && !/\s$/.test(head)) {
    const border = head.search(/\s\S*$/);
    if (border > 0 && border >= Math.max(cut - 30, Math.floor(cut * 0.6))) head = head.slice(0, border);
  }
  head = head.replace(/[\s.,;:!?\-–—([{]+$/u, "");
  return head + "…";
}

const STOP_WORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below " +
    "between both but by can cannot could did do does doing down during each either else ever every few for " +
    "from further get got had has have having he her here hers herself him himself his how however if in into " +
    "is it its itself just let like may me might more most much must my myself new no nor not now of off on " +
    "once only or other our ours ourselves out over own per same shall she should since so some such than that " +
    "the their theirs them themselves then there these they this those through to too under until up upon us " +
    "very via was we were what when where whether which while who whom whose why will with within without " +
    "would yet you your yours yourself yourselves " +
    "dont doesnt didnt cant wont isnt arent wasnt werent hasnt havent hadnt shouldnt wouldnt couldnt " +
    "youre theyre weve youve theyve youll theyll ive lets"
  ).split(" "),
);

const WORD = /[\p{L}\p{M}\p{N}]+(?:(?<=\p{N})\.\p{N}[\p{L}\p{M}\p{N}]*)*/gu;

/**
 * The words that carry meaning, in order, with no duplicates: lower case, split on characters that
 * are not letters or digits (a dot between digits stays, as in "v2.1"), English stop words dropped,
 * and words of fewer than 3 characters dropped unless they hold a digit.
 */
export function significantWords(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const prepared = stripInvisible(text)
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])['’‘`]s(?![\p{L}\p{N}])/gu, "")
    .replace(/(?<=[\p{L}\p{N}])['’‘`](?=\p{L})/gu, "");
  const seen = new Set<string>();
  for (const match of prepared.matchAll(WORD)) {
    const word = match[0];
    if (seen.has(word) || STOP_WORDS.has(word)) continue;
    if (word.length < 3 && !/\p{N}/u.test(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/**
 * The form of a text for comparison: lower case, punctuation and symbols removed, single spaces.
 * Two texts that differ only in case, punctuation, or spacing have the same result.
 */
export function normalizeForHash(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return stripInvisible(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** SHA-256 of the text (UTF-8), as lower-case hex. */
export function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A name for an address: lower case, letters and digits, "-" between words, at most 60 characters. */
export function slugify(name: string): string {
  if (typeof name !== "string") return "item";
  const words = stripInvisible(name)
    .normalize("NFKD")
    .replace(/([a-zA-Z])\p{M}+/gu, "$1") // "é" -> "e"; marks of other scripts stay
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const chars = Array.from(words);
  if (chars.length <= 60) return words === "" ? "item" : words;
  let cut = chars.slice(0, 60).join("");
  if (chars[60] !== "-") {
    const border = cut.lastIndexOf("-");
    if (border >= 30) cut = cut.slice(0, border);
  }
  cut = cut.replace(/-+$/g, "");
  return cut === "" ? "item" : cut;
}
