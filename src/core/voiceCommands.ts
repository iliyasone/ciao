// Spoken commands inside the transcript. Recognition may write the word in Cyrillic or Latin
// ("чао", "Ciao") with any punctuation between repeats ("Чао-чао.", "ciao, ciao").

const WORD = "(?:чао|ciao|чау)";
const SEP = "[\\s,.!?…:;—–-]*";
const STOP_AT_END = new RegExp(`${SEP}(?<!\\p{L})${WORD}${SEP}${WORD}${SEP}$`, "iu");

/** The transcript so far ends with "чао-чао": the speaker wants to finish. */
export function endsWithStopPhrase(text: string): boolean {
  return STOP_AT_END.test(text);
}

/** Removes a trailing "чао-чао" (and the punctuation around it) from the final text. */
export function stripStopPhrase(text: string): string {
  return text.replace(STOP_AT_END, "").trimEnd();
}
