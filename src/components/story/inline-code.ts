// Model text renders as text (specification §7.5): inline code in backticks
// becomes <code>; nothing else is interpreted. This file has the pure split;
// ModelText.tsx renders it.

export type TextSegment = { kind: "text"; value: string } | { kind: "code"; value: string };

/**
 * Splits text into plain parts and `code` parts. A pair of single backticks
 * with at least one character between them (on one line) is code. A lone
 * backtick, an empty pair, or a pair across a line break stays text.
 */
export function splitInlineCode(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const inner = match[1] ?? "";
    if (inner.trim() === "") continue;
    if (start > last) segments.push({ kind: "text", value: text.slice(last, start) });
    segments.push({ kind: "code", value: inner });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", value: text.slice(last) });
  // Join neighbouring text parts (a skipped blank pair leaves two).
  return segments.reduce<TextSegment[]>((out, segment) => {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "text" && segment.kind === "text") prev.value += segment.value;
    else out.push({ ...segment });
    return out;
  }, []);
}
