// Paragraphs and lists for long dictations, without letting a model touch the words.
//
// The transcript is cut into numbered segments (sentences; also a long pause followed by a
// capitalised word). A fast LLM only returns the structure — which segments form paragraphs,
// which form list items — and the text is assembled here. So the words stay exactly as
// transcribed; only leading enumerators ("во-первых", "второе") are dropped from list items.

export interface Segment {
  text: string;
  /** The speaker paused for a while right before this segment. */
  afterPause: boolean;
}

export type Block = { type: "paragraph"; segments: number[] } | { type: "list"; ordered: boolean; items: number[][] };

const PAUSE_SLACK = 3; // chars between a pause position and a segment start that still count as "at"

/**
 * @param pauses character offsets in `text` where a long pause happened.
 */
export function segment(text: string, pauses: number[]): Segment[] {
  const cuts = new Set<number>();
  // Sentence ends.
  for (const m of text.matchAll(/[.!?…]+["»”)]*\s+/g)) cuts.add(m.index! + m[0].length);
  // A pause followed by a capital letter starts a new sentence even without punctuation.
  for (const p of pauses) {
    const rest = text.slice(p).match(/^\s*/)![0].length;
    if (/\p{Lu}/u.test(text[p + rest] ?? "")) cuts.add(p + rest);
  }
  const bounds = [0, ...[...cuts].filter((c) => c > 0 && c < text.length).sort((a, b) => a - b), text.length];
  const segments: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const raw = text.slice(bounds[i], bounds[i + 1]);
    if (!raw.trim()) continue;
    const start = bounds[i]!;
    segments.push({ text: raw.trim(), afterPause: pauses.some((p) => Math.abs(p - start) <= PAUSE_SLACK || (p < start && text.slice(p, start).trim() === "")) });
  }
  return segments;
}

const ENUMERATION_CUE = /(?:^|[\s,.])(?:во-первых|во-вторых|перв(?:ое|ый момент)|втор(?:ое|ой момент)|трет(?:ье|ий момент)|first(?:ly)?|second(?:ly)?)[\s,.:—-]/iu;

/** Only worth a model call (and its ~1 s) when there is something to structure. */
export function worthFormatting(segments: Segment[]): boolean {
  if (segments.length < 3) return false;
  const text = segments.map((s) => s.text).join(" ");
  const words = text.split(/\s+/).length;
  return words >= 60 || ENUMERATION_CUE.test(text) || segments.filter((s) => s.afterPause).length >= 2;
}

export const FORMAT_INSTRUCTIONS = `You lay out a dictated message (a transcript of speech, usually Russian) as paragraphs and lists.
You get the transcript as numbered segments, in order. "[pause]" marks a segment the speaker started after a long pause — a hint for a new paragraph or list item.
List only the segments that START something, each with its kind:
P = a new paragraph
N = a new item of a numbered list (the speaker counts: "первое… второе…", "во-первых…", or the order matters)
B = a new item of a bulleted list (several parallel points or requests in a row, not counted)
Every segment not listed continues the paragraph or list item before it. Segment 0 always starts something.
Prefer a few meaningful paragraphs (typically 2–6 sentences); a short message is a single paragraph. Use a list only when the speaker really enumerates; an item may span several segments.`;

export const FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["starts"],
  properties: {
    starts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "kind"],
        properties: { at: { type: "integer" }, kind: { type: "string", enum: ["P", "N", "B"] } },
      },
    },
  },
} as const;

export function formatPrompt(segments: Segment[]): string {
  return segments.map((s, i) => `${i}.${s.afterPause ? " [pause]" : ""} ${s.text}`).join("\n");
}

/** Parses the model's answer into blocks; null if it is malformed. */
export function parseBlocks(json: string, count: number): Block[] | null {
  let starts: { at: number; kind: string }[];
  try {
    starts = JSON.parse(json).starts;
  } catch {
    return null;
  }
  if (!Array.isArray(starts)) return null;
  const marks: string[] = Array.from({ length: count }, () => "+");
  for (const { at, kind } of starts) {
    if (!Number.isInteger(at) || at < 0 || at >= count || !/^[PNB]$/.test(kind)) return null;
    marks[at] = kind;
  }
  if (marks[0] === "+") marks[0] = "P";
  const blocks: Block[] = [];
  marks.forEach((m, i) => {
    const last = blocks.at(-1);
    if (m === "+") {
      if (last?.type === "paragraph") last.segments.push(i);
      else last!.items.at(-1)!.push(i);
    } else if (m === "P") {
      blocks.push({ type: "paragraph", segments: [i] });
    } else {
      const ordered = m === "N";
      if (last?.type === "list" && last.ordered === ordered) last.items.push([i]);
      else blocks.push({ type: "list", ordered, items: [[i]] });
    }
  });
  return blocks;
}

const ENUMERATOR =
  /^(?:во-первых|во-вторых|в-третьих|в-четв[её]ртых|в-пятых|перв(?:ое|ый момент)|втор(?:ое|ой момент)|трет(?:ье|ий момент)|четв[её]рт(?:ое|ый момент)|пят(?:ое|ый момент)|шест(?:ое|ой момент)|седьм(?:ое|ой момент)|восьм(?:ое|ой момент)|девят(?:ое|ый момент)|десят(?:ое|ый момент)|дальше|далее|и ещё|ещё|следующ(?:ее|ий момент)|пункт \S+|first(?:ly)?|second(?:ly)?|third(?:ly)?|next)(?:\s*[,:.—–-]+\s*|\s+)/iu;

// Inside a numbered list these always open a new item, whatever the model said.
const ORDINAL_START =
  /^(?:во-вторых|в-третьих|в-четв[её]ртых|в-пятых|втор(?:ое|ой момент)|трет(?:ье|ий момент)|четв[её]рт(?:ое|ый момент)|пят(?:ое|ый момент)|шест(?:ое|ой момент)|седьм(?:ое|ой момент)|восьм(?:ое|ой момент)|девят(?:ое|ый момент)|десят(?:ое|ый момент)|и ещё|second(?:ly)?|third(?:ly)?)(?![\p{L}-])/iu;

function splitAtOrdinals(blocks: Block[], segments: Segment[]): Block[] {
  return blocks.map((b) => {
    if (b.type !== "list" || !b.ordered) return b;
    const items: number[][] = [];
    for (const item of b.items) {
      let current: number[] = [];
      for (const id of item) {
        if (current.length && ORDINAL_START.test(segments[id]!.text)) {
          items.push(current);
          current = [];
        }
        current.push(id);
      }
      items.push(current);
    }
    return { ...b, items };
  });
}

const capitalise = (s: string) => s.charAt(0).toLocaleUpperCase("ru-RU") + s.slice(1);

export function renderBlocks(layout: Block[], segments: Segment[]): string {
  const blocks = splitAtOrdinals(layout, segments);
  const join = (ids: number[]) => ids.map((i) => segments[i]!.text).join(" ");
  const parts: string[] = [];
  for (const b of blocks) {
    let chunk: string;
    if (b.type === "paragraph") chunk = join(b.segments);
    else
      chunk = b.items
        .map((item, n) => {
          const stripped = join(item).replace(ENUMERATOR, "");
          return `${b.ordered ? `${n + 1}.` : "-"} ${capitalise(stripped || join(item))}`;
        })
        .join("\n");
    // "Сделай так:" followed by a list reads better without a blank line in between.
    const prev = parts.at(-1);
    if (prev !== undefined && b.type === "list" && /:\s*$/.test(prev)) parts[parts.length - 1] = `${prev}\n${chunk}`;
    else parts.push(chunk);
  }
  return parts.join("\n\n");
}
