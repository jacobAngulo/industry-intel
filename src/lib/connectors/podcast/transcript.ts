// Podcast transcripts (Podcasting 2.0 <podcast:transcript>) to plain text:
// no time codes, no cue numbers.
import { z } from "zod";

import { decodeEntities, htmlToText, stripInvisible } from "@/lib/text";

export interface TranscriptRef {
  url: string;
  type: string;
  language?: string;
  rel?: string;
}

export type TranscriptFormat = "text" | "vtt" | "srt" | "html" | "json";

/** The order of preference of §6.3. */
const FORMAT_ORDER: TranscriptFormat[] = ["text", "vtt", "srt", "html", "json"];

export function formatOf(type: string): TranscriptFormat | null {
  const t = type.toLowerCase().split(";")[0]?.trim() ?? "";
  if (t === "text/plain") return "text";
  if (t === "text/vtt") return "vtt";
  if (t === "application/srt" || t === "application/x-subrip" || t === "text/srt" || t === "application/x-srt") return "srt";
  if (t === "text/html") return "html";
  if (t === "application/json") return "json";
  return null;
}

/** The transcript to fetch: the best format of the list, or null. */
export function pickTranscript(value: unknown): (TranscriptRef & { format: TranscriptFormat }) | null {
  if (!Array.isArray(value)) return null;
  const refs: Array<TranscriptRef & { format: TranscriptFormat }> = [];
  for (const v of value) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
    const format = formatOf(typeof r.type === "string" ? r.type : "");
    if (!format) continue;
    refs.push({ url: r.url, type: String(r.type), format, ...(typeof r.language === "string" ? { language: r.language } : {}) });
  }
  refs.sort((a, b) => FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format));
  return refs[0] ?? null;
}

const TIMING = /-->/;
const SPEAKER_TAG = /<v(?:\.[^\s>]*)?\s+([^>]+)>/gi;

/** Joins cue texts into paragraphs: a new paragraph when the speaker changes. */
function joinCues(cues: Array<{ speaker?: string; text: string }>): string {
  const paragraphs: string[] = [];
  let current: { speaker?: string; parts: string[] } | null = null;
  let last = "";
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (text === "" || text === last) continue; // captions often repeat a line
    last = text;
    if (!current || (cue.speaker !== undefined && cue.speaker !== current.speaker)) {
      if (current) paragraphs.push(`${current.speaker ? `${current.speaker}: ` : ""}${current.parts.join(" ")}`);
      current = { ...(cue.speaker !== undefined ? { speaker: cue.speaker } : {}), parts: [] };
    }
    current.parts.push(text);
  }
  if (current) paragraphs.push(`${current.speaker ? `${current.speaker}: ` : ""}${current.parts.join(" ")}`);
  return paragraphs.join("\n\n");
}

/** "Name: text" at the start of a cue (SubRip and plain captions). */
function leadingSpeaker(text: string): { speaker?: string; text: string } {
  const m = /^([A-Z][\w.'-]{0,20}(?: [A-Z][\w.'-]{0,20}){0,3}):\s+(.*)$/s.exec(text);
  return m ? { speaker: (m[1] ?? "").trim(), text: m[2] ?? "" } : { text };
}

function cleanCueText(text: string): string {
  return decodeEntities(
    text
      .replace(/<\d{2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, "") // inline timestamps
      .replace(/<\/?[a-z][^>]*>/gi, "") // <c>, <i>, <b>, <u>, <lang>
      .replace(/\{\\[^}]*\}/g, ""), // SubRip style codes {\an8}
  );
}

/** WebVTT to plain text. */
export function vttToText(source: string): string {
  const blocks = stripInvisible(source).replace(/^﻿/, "").split(/\n\s*\n/);
  const cues: Array<{ speaker?: string; text: string }> = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    const timingIndex = lines.findIndex((l) => TIMING.test(l));
    if (timingIndex < 0) continue; // WEBVTT header, NOTE, STYLE, REGION
    const body = lines.slice(timingIndex + 1).join("\n");
    let speaker: string | undefined;
    const withSpeakers = body.replace(SPEAKER_TAG, (_m, name: string) => {
      speaker ??= name.trim();
      return "";
    });
    const text = cleanCueText(withSpeakers).replace(/\n+/g, " ");
    const lead = speaker === undefined ? leadingSpeaker(text.trim()) : { speaker, text };
    cues.push({ ...(lead.speaker !== undefined ? { speaker: lead.speaker } : {}), text: lead.text });
  }
  return joinCues(cues);
}

/** SubRip (.srt) to plain text. */
export function srtToText(source: string): string {
  const blocks = stripInvisible(source).replace(/^﻿/, "").split(/\n\s*\n/);
  const cues: Array<{ speaker?: string; text: string }> = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    const timingIndex = lines.findIndex((l) => TIMING.test(l));
    if (timingIndex < 0) continue;
    const text = cleanCueText(lines.slice(timingIndex + 1).join(" ")).trim();
    const lead = leadingSpeaker(text);
    cues.push({ ...(lead.speaker !== undefined ? { speaker: lead.speaker } : {}), text: lead.text });
  }
  return joinCues(cues);
}

const jsonTranscriptSchema = z.object({
  segments: z
    .array(
      z.object({
        speaker: z.union([z.string(), z.number()]).optional().nullable(),
        body: z.string().optional().nullable(),
      }),
    )
    .max(200_000),
});

/** The JSON transcript of the Podcasting 2.0 namespace ({ segments: [{ speaker?, body }] }) to plain text. */
export function jsonTranscriptToText(source: string): string {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return "";
  }
  const parsed = jsonTranscriptSchema.safeParse(data);
  if (!parsed.success) return "";
  return joinCues(
    parsed.data.segments.map((s) => ({
      ...(s.speaker !== undefined && s.speaker !== null && String(s.speaker).trim() !== "" ? { speaker: String(s.speaker).trim() } : {}),
      text: stripInvisible(s.body ?? ""),
    })),
  );
}

/** An HTML transcript to plain text: no <time> elements, no lines that hold only a time code. */
export function htmlTranscriptToText(source: string): string {
  const text = htmlToText(source.replace(/<time\b[^>]*>[\s\S]*?<\/time\s*>/gi, " "));
  return text
    .split("\n")
    .filter((line) => !/^\s*\[?\(?\d{1,2}(?::\d{2}){1,2}(?:[.,]\d{1,3})?\)?\]?\s*$/.test(line))
    .join("\n")
    .replace(/^([^\n:]{1,40}:)\s*\n+/gm, "$1 ") // "Speaker:" on its own line joins the next paragraph
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text of a transcript in the given format. */
export function transcriptToText(source: string, format: TranscriptFormat): string {
  switch (format) {
    case "text":
      return stripInvisible(source)
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    case "vtt":
      return vttToText(source);
    case "srt":
      return srtToText(source);
    case "html":
      return htmlTranscriptToText(source);
    case "json":
      return jsonTranscriptToText(source);
  }
}
