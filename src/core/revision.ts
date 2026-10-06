import { PARAGRAPH_PAUSE_MS, type Pause } from "./liveLayout";

const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): { word: string; start: number }[] {
  return [...text.matchAll(WORD)].map((m) => ({ word: m[0].toLowerCase(), start: m.index }));
}

/** Where a pause goes before the word starting at `start`: on the space before it, as with a delta. */
function before(text: string, start: number): number {
  return start > 0 && /\s/.test(text[start - 1]!) ? start - 1 : start;
}

/**
 * Pauses after the live text was revised rather than extended (Gemini replaces its whole guess, and
 * its final may rewrite the start: "Ну, привет." → "Привет."). Each pause after the first change
 * moves with the words that followed it (the next two, or the next one), in order; one whose words
 * are gone is dropped. A long gap before this revision becomes a pause before its first new word.
 * Also returns where the text starts to differ.
 */
export function revisePauses(prev: string, next: string, pauses: Pause[], gapMs: number): { same: number; pauses: Pause[] } {
  let same = 0;
  while (same < next.length && next[same] === prev[same]) same++;
  const kept = pauses.filter((p) => p.at <= same);

  const nextWords = words(next);
  const prevWords = words(prev);
  let from = nextWords.findIndex((w) => w.start >= same);
  if (from < 0) from = nextWords.length;
  for (const p of pauses) {
    if (p.at <= same) continue;
    const after = prevWords.filter((w) => w.start >= p.at).map((w) => w.word);
    for (const n of [2, 1]) {
      const want = after.slice(0, n);
      if (want.length < n) continue;
      const j = nextWords.findIndex((_, i) => i >= from && want.every((w, k) => nextWords[i + k]?.word === w));
      if (j < 0) continue;
      const at = before(next, nextWords[j]!.start);
      if (at > 0) kept.push({ at, ms: p.ms });
      from = j + 1;
      break;
    }
  }

  if (same > 0 && gapMs >= PARAGRAPH_PAUSE_MS) {
    const first = nextWords.find((w) => w.start >= same && w.start > 0);
    if (first) {
      const at = before(next, first.start);
      if (!kept.some((p) => p.at === at)) kept.push({ at, ms: gapMs });
    }
  }
  kept.sort((a, b) => a.at - b.at);
  return { same, pauses: kept };
}
