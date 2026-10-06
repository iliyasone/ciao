import { PARAGRAPH_PAUSE_MS, type Pause } from "./liveLayout";

/**
 * Pauses after the live text was revised rather than extended (Gemini replaces its whole guess):
 * those inside the part that stayed the same keep their place, and a long gap before this revision
 * becomes a pause before the first new word, as it would after a delta. Returns where the text
 * starts to differ, too.
 */
export function revisePauses(prev: string, next: string, pauses: Pause[], gapMs: number): { same: number; pauses: Pause[] } {
  let same = 0;
  while (same < next.length && next[same] === prev[same]) same++;
  const kept = pauses.filter((p) => p.at <= same);
  // At the space before the next word, as with a delta (" давай" after "Привет,").
  const space = same > 0 && gapMs >= PARAGRAPH_PAUSE_MS ? next.slice(same).search(/\s/) : -1;
  if (space >= 0 && /\S/.test(next.slice(same + space))) kept.push({ at: same + space, ms: gapMs });
  return { same, pauses: kept };
}
