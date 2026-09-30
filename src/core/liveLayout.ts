// Paragraphs and numbered lists, decided by simple rules while the text streams in, so the live
// card shows the structure as you speak and the pasted text has exactly the same layout.
//
// - A long pause before a new sentence starts a paragraph.
// - A sentence starting with an ordinal ("Первое", "Во-вторых", "Третий момент") starts a list
//   item; inside a list "И ещё", "Дальше", "Также" do too. The leading word is dropped and the
//   next letter capitalised. Sentences without such a start continue the current item.
// - Inside a list only a longer pause ends it, so thinking pauses within an item don't.
// Nothing here calls a model: it has to be instant and identical in preview and result.

export interface Pause {
  /** Character offset in the text where the speaker paused. */
  at: number;
  ms: number;
}

export type Break = { at: number; kind: "paragraph" } | { at: number; kind: "item"; n: number };

/** Replace text[start, end) with `insert` (drops the ordinal, capitalises what follows). */
export interface Edit {
  start: number;
  end: number;
  insert: string;
}

export interface Layout {
  breaks: Break[];
  edits: Edit[];
}

export const PARAGRAPH_PAUSE_MS = 1200;
const LIST_END_PAUSE_MS = 2000;

const ORDINALS: [RegExp, number][] = [
  [/во-первых|перв(?:ое|ый момент|ый пункт)|first(?:ly)?/, 1],
  [/во-вторых|втор(?:ое|ой момент|ой пункт)|second(?:ly)?/, 2],
  [/в-третьих|трет(?:ье|ий момент|ий пункт)|third(?:ly)?/, 3],
  [/в-четв[её]ртых|четв[её]рт(?:ое|ый момент|ый пункт)/, 4],
  [/в-пятых|пят(?:ое|ый момент|ый пункт)/, 5],
  [/в-шестых|шест(?:ое|ой момент|ой пункт)/, 6],
  [/в-седьмых|седьм(?:ое|ой момент|ой пункт)/, 7],
  [/в-восьмых|восьм(?:ое|ой момент|ой пункт)/, 8],
  [/в-девятых|девят(?:ое|ый момент|ый пункт)/, 9],
  [/в-десятых|десят(?:ое|ый момент|ый пункт)/, 10],
];
const ORDINAL = new RegExp(`^(?:${ORDINALS.map(([r]) => r.source).join("|")})(?![\\p{L}-])`, "iu");
const CONTINUE = /^(?:и ещё|и еще|ещё|еще|дальше|далее|также|и также|и последнее|последнее|next|also)(?![\p{L}-])/iu;
const AFTER_WORD = /^[\s,:;.!—–-]*/u;

function sentenceStarts(text: string, pauses: Pause[]): number[] {
  const starts = new Set<number>();
  const first = text.search(/\S/);
  if (first >= 0) starts.add(first);
  for (const m of text.matchAll(/[.!?…]+["»”)]*\s+(?=\S)/gu)) starts.add(m.index! + m[0].length);
  // A pause followed by a capital letter starts a sentence even without punctuation.
  for (const p of pauses) {
    const s = p.at + text.slice(p.at).search(/\S|$/);
    if (/\p{Lu}/u.test(text[s] ?? "")) starts.add(s);
  }
  return [...starts].filter((s) => s < text.length).sort((a, b) => a - b);
}

/** The longest pause right before `start` (only whitespace in between). */
function pauseBefore(text: string, pauses: Pause[], start: number): number {
  let ms = 0;
  for (const p of pauses) if (p.at <= start && text.slice(p.at, start).trim() === "") ms = Math.max(ms, p.ms);
  return ms;
}

export function layout(text: string, pauses: Pause[]): Layout {
  const breaks: Break[] = [];
  const edits: Edit[] = [];
  let item = 0; // current list item number, 0 = not in a list

  const startItem = (start: number, word: string, n: number) => {
    breaks.push({ at: start, kind: "item", n });
    const end = start + word.length + text.slice(start + word.length).match(AFTER_WORD)![0].length;
    const next = text[end];
    // Only once the next letter has arrived, so a half-streamed word isn't mangled.
    if (next && /\p{L}/u.test(next)) edits.push({ start, end: end + 1, insert: next.toLocaleUpperCase("ru-RU") });
    else if (next === undefined) edits.push({ start, end, insert: "" });
    item = n;
  };

  for (const start of sentenceStarts(text, pauses)) {
    const rest = text.slice(start);
    const pause = pauseBefore(text, pauses, start);
    const ordinal = rest.match(ORDINAL);
    if (ordinal) {
      const value = ORDINALS.find(([r]) => new RegExp(`^(?:${r.source})$`, "iu").test(ordinal[0]))![1];
      startItem(start, ordinal[0], item ? item + 1 : value);
      continue;
    }
    const cont = item ? rest.match(CONTINUE) : null;
    if (cont) {
      startItem(start, cont[0], item + 1);
      continue;
    }
    if (start === 0 || text.slice(0, start).trim() === "") continue;
    if (item ? pause >= LIST_END_PAUSE_MS : pause >= PARAGRAPH_PAUSE_MS) {
      breaks.push({ at: start, kind: "paragraph" });
      item = 0;
    }
  }
  return { breaks, edits };
}

/** The laid-out text as plain text/Markdown: blank lines between paragraphs, "1. " items. */
export function applyLayout(text: string, l: Layout): string {
  const marks = new Map(l.breaks.map((b) => [b.at, b]));
  const edits = new Map(l.edits.map((e) => [e.start, e]));
  let out = "";
  let prevItem = false;
  for (let i = 0; i < text.length; ) {
    const b = marks.get(i);
    if (b) {
      out = out.trimEnd();
      if (out) out += b.kind === "item" && (prevItem || out.endsWith(":")) ? "\n" : "\n\n";
      if (b.kind === "item") out += `${b.n}. `;
      prevItem = b.kind === "item";
    }
    const e = edits.get(i);
    if (e) {
      out += e.insert;
      i = e.end;
    } else {
      out += text[i];
      i++;
    }
  }
  return out.trim();
}
