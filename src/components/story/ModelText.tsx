import { splitInlineCode } from "./inline-code";

/** Text from the model or a source: plain text, with `inline code` as <code>. Never HTML. */
export function ModelText({ text }: { text: string }) {
  const segments = splitInlineCode(text);
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "code" ? (
          <code key={i} className="rounded-[4px] bg-surface-2 px-1 py-px font-mono text-[0.875em] text-fg">
            {segment.value}
          </code>
        ) : (
          <span key={i}>{segment.value}</span>
        ),
      )}
    </>
  );
}
