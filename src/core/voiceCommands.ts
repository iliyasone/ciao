// Spoken commands inside the transcript. Recognition may write the word in Cyrillic or Latin
// ("чао", "Ciao") with any punctuation between repeats ("Чао-чао.", "ciao, ciao").

const WORD = "(?:чао|ciao|чау)";
const SEP = "[\\s,.!?…:;—–-]*";
const STOP_AT_END = new RegExp(`${SEP}(?<!\\p{L})${WORD}${SEP}${WORD}${SEP}$`, "iu");

/** The transcript so far ends with "чао-чао": the speaker wants to finish. */
export function endsWithStopPhrase(text: string): boolean {
  return STOP_AT_END.test(text);
}

const WAKE_AT_START = new RegExp(`^\\s*(?:${WORD}|ао)(?!\\p{L})${SEP}`, "iu");

/**
 * Removes the wake word from the start of a dictation it started: the audio handed over from the
 * detector usually begins with (the tail of) "чао".
 */
export function stripWakeWord(text: string): string {
  const stripped = text.replace(WAKE_AT_START, "");
  if (stripped === text) return text;
  return stripped.charAt(0).toLocaleUpperCase("ru-RU") + stripped.slice(1);
}

/** Removes a trailing "чао-чао" (and the punctuation around it) from the final text. */
export function stripStopPhrase(text: string): string {
  return text.replace(STOP_AT_END, "").trimEnd();
}
