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

// ── "Чао, запомни слово PostHog" ──────────────────────────────────────────
// The speaker asks to add a term (settings.keywords). The command is cut out of the text; the
// words after it are the term as heard: written out ("PostHog", "пост хог") or spelled letter by
// letter ("пэ, о, эс, тэ", "P-O-S-T"). src/core/terms.ts turns them into the term itself.

// The noun is required: "Чао, добавь тесты" or "Чао, запомни: мы на pnpm" is dictation, not a command
// (a wake-word start always begins with "Чао").
const VERB_AND_NOUN =
  `(?:запомни|запиши|добавь|remember|add)(?!\\p{L})` +
  `(?:${SEP}(?:в|to|the|a|an|my|новое|новый|new)(?!\\p{L}))?` +
  `${SEP}(?:словарь|слово|термины|термин|words?|terms?|vocabulary|dictionary)(?!\\p{L})` +
  // "добавь в словарь слово …"
  `(?:${SEP}(?:слово|термин|word|term)(?!\\p{L}))?` +
  `(?:${SEP}(?:по буквам|spelled|spelt))?`;
// "ао": a wake-word start may begin with the tail of "чао" (see stripWakeWord), or with none of it.
const REMEMBER = `(?:^\\s*ао|(?<!\\p{L})${WORD})${SEP}${VERB_AND_NOUN}`;
const REMEMBER_AFTER_WAKE = `(?:^\\s*(?:ао)?|(?<!\\p{L})${WORD})${SEP}${VERB_AND_NOUN}`;
/** Where the term goes, said after it: "…слово PostHog в словарь", "…PostHog to my dictionary". */
const DESTINATION = /^[\s,]*(?:в|to)\s+(?:(?:my|the)\s+)?(?:словарь|термины|dictionary|vocabulary|terms|words)(?!\p{L})/iu;

/** A word, a number or an identifier such as "Next.js", "C++" or "gpt-5". */
const TOKEN = /[\p{L}\p{N}]+(?:[.+#_'’][\p{L}\p{N}]+)*[+#]*/gu;

/** Russian and English letter names, as a recognizer writes them in either script. */
const LETTER_NAMES = new Set(
  (
    "а бэ бе вэ ве гэ ге дэ де е ё жэ же зэ зе и й ка эль эл эм эн о пэ пе эр эс тэ те у эф ха цэ це че ша ща ы э ю я икс игрек " +
    "эй би си ди иф джи эйч ай джей кей оу пи кью ар ти ви дабл даблю уай вай зед зи экс " +
    "bee cee dee gee jay kay el em en oh pee cue ar ess tee vee double ex why zed zee aitch"
  ).split(" "),
);

/** Letters that are words too, and may start the next sentence. */
const LETTER_WORDS = new Set("а и я в с к о у a i".split(" "));

function isLetter(token: string): boolean {
  return /^\p{L}$/u.test(token) || LETTER_NAMES.has(token.toLowerCase());
}

/** Gaps between words in a spoken spelling; a sentence end anywhere else ends the term. */
const SPELLING_GAP = /^[\s,.\-–—:;]*$/u;
/** Words of a written-out term, at most this many: the rest of the sentence is dictation again. */
const MAX_WORDS = 3;
/** Dictation goes on after the term ("…слово PostHog и запушь"). */
const GOES_ON = new Set("и а но или в потом дальше это теперь and but or to then now this".split(" "));
/** "latin", "other" (Cyrillic), or null for a number. */
const script = (word: string) => (/\p{Script=Latin}/u.test(word) ? "latin" : /\p{L}/u.test(word) ? "other" : null);

export interface RememberCommand {
  /** What was heard as the term, e.g. "PostHog", "пост хог" or "пэ, о, эс, тэ". */
  heard: string;
  /** Spelled letter by letter. */
  spelled: boolean;
}

/**
 * Finds "чао, запомни слово …" commands and removes them (with the term after each) from the
 * text. A command with nothing after it is removed too, and comes back with heard = "".
 * wakeStarted: the dictation was started by the wake word, so its text may begin with the command
 * without the "чао" (the detector's audio can start after the word).
 */
export function takeRememberCommands(text: string, wakeStarted = false): { text: string; commands: RememberCommand[] } {
  const commands: RememberCommand[] = [];
  let out = "";
  let from = 0;
  const re = new RegExp(wakeStarted ? REMEMBER_AFTER_WAKE : REMEMBER, "giu");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const term = readTerm(text, m.index + m[0].length);
    commands.push(term.command);
    out += text.slice(from, m.index);
    const end = term.end + (DESTINATION.exec(text.slice(term.end))?.[0].length ?? 0);
    // The punctuation after the term goes with it.
    from = end + (/^[\s,.!?…;:»"”’)\]]*/u.exec(text.slice(end))?.[0].length ?? 0);
    re.lastIndex = from;
  }
  if (!commands.length) return { text, commands };
  // The text went on after a command at its start: begin it with a capital, as stripWakeWord does.
  const capital = !out.trim();
  out = (out + text.slice(from))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[\s,;:—–\-«"„“(]+$/u, "")
    .trim();
  return { text: capital ? out.charAt(0).toLocaleUpperCase("ru-RU") + out.slice(1) : out, commands };
}

/** The term after a command that ends at `start`, and where it ends. */
function readTerm(text: string, start: number): { end: number; command: RememberCommand } {
  const tokens = [...text.slice(start).matchAll(TOKEN)].map((m) => ({ word: m[0], from: start + m.index, to: start + m.index + m[0].length }));
  if (!tokens.length) return { end: text.length, command: { heard: "", spelled: false } };
  const word = (i: number) => tokens[i]?.word.toLowerCase() ?? "";
  /** What separates token i from the one before. */
  const gap = (i: number) => text.slice(tokens[i - 1]!.to, tokens[i]!.from);
  /** Letter j goes on a spelling; one that is a word too only before another letter ("…эм, а потом" ends at "эм"). */
  const spells = (j: number) =>
    isLetter(word(j)) &&
    SPELLING_GAP.test(gap(j)) &&
    (!LETTER_WORDS.has(word(j)) || j + 1 === tokens.length || (isLetter(word(j + 1)) && !LETTER_WORDS.has(word(j + 1))));
  /** Two or more letters from token i on: the index after the last; otherwise i. */
  const spelling = (i: number) => {
    let j = isLetter(word(i)) ? i + 1 : i;
    while (j > i && j < tokens.length && spells(j)) j++;
    return j - i >= 2 ? j : i;
  };
  let end = spelling(0);
  let spelled = end > 0;
  if (!spelled) {
    // Written out: the words up to a punctuation mark or the dictation going on…
    const first = script(word(0));
    const switches = (i: number) => script(word(i)) !== null && script(word(i)) !== first;
    const goesOn = (i: number) => /[,.!?…;:\n»"”’)]/u.test(gap(i)) || GOES_ON.has(word(i)) || switches(i);
    end = 1;
    while (end < tokens.length && end < MAX_WORDS && !goesOn(end)) end++;
    // …and maybe spelled right after ("PostHog, по буквам: пэ, о, эс, тэ…").
    let next = end;
    if (next < tokens.length && SPELLING_GAP.test(gap(next))) {
      if (word(next) === "по" && word(next + 1) === "буквам") next += 2;
      else if (word(next) === "spelled" || word(next) === "spelt") next += 1;
      const to = spelling(next);
      if (to > next) [end, spelled] = [to, true];
    }
  }
  const to = tokens[end - 1]!.to;
  return { end: to, command: { heard: text.slice(tokens[0]!.from, to), spelled } };
}
