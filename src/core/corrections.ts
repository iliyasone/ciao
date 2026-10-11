// Words the user corrected in a pasted dictation, found by comparing what Ciao pasted with what the
// field holds a little later (or with an edit made in History). A correction worth remembering is a
// word or two replaced by something that sounds the same ("постхок" → "PostHog", "клод код" →
// "Claude Code"): recognition got the sound right but not the spelling, and the term list fixes that
// next time. Rewrites, added sentences, typo fixes in ordinary lowercase words and punctuation are
// not. Ciao only suggests; the user confirms. Pure functions: the Kotlin port in android/
// (Corrections.kt) must give the same results (its tests hold these outputs).

export interface Correction {
  /** What recognition wrote. */
  heard: string;
  /** What the user changed it to: the term to suggest. */
  fixed: string;
}

interface Word {
  text: string;
  key: string;
  start: number;
  end: number;
}

// A word may hold inner dots, hyphens, underscores, apostrophes and pluses: "Node.js", "gpt-5", "C++".
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}]|[.\-_'’+](?=[\p{L}\p{N}+]))*\+*/gu;

function words(text: string): Word[] {
  return [...text.normalize("NFC").matchAll(WORD)].map((m) => ({ text: m[0], key: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
}

/** At most this many words on either side of one correction; more is a rewrite. */
const MAX_SPAN = 3;
/** Share of the inserted words that must still be there, unchanged, for the field to count as holding our text (one is enough for a short one). */
const MIN_KEPT = 0.5;
const SHORT = 6;
const MAX_TERM_LENGTH = 40;
const MAX_WORDS = 1500;
/** Not terms, however they are spelled. */
const NOT_TERMS = new Set(["ok", "ок", "okay", "окей"]);

/**
 * The corrections between `inserted` (what Ciao pasted) and `field` (the field's text now, which may
 * hold other text around it). null: the inserted text is no longer there (sent, deleted, rewritten),
 * so watching this field can stop.
 */
export function findCorrections(inserted: string, field: string): Correction[] | null {
  // Offsets below index the texts as compared: composed, as macOS may hand "й" over as "и" + a mark.
  inserted = inserted.normalize("NFC");
  field = field.normalize("NFC");
  const a = words(inserted);
  const b = words(field);
  if (!a.length) return null;
  const window = locate(a, b);
  if (!window) return null;
  // The alignment takes memory and time in the square of the length: an hour-long dictation is
  // not compared (its words are not lost, just not offered).
  if (a.length > MAX_WORDS) return [];
  const ops = align(a, b.slice(window.from, window.to));
  const kept = ops.filter((o) => o.kind === "same").length;
  if (kept < (a.length < SHORT ? 1 : Math.ceil(a.length * MIN_KEPT))) return null;

  const found: Correction[] = [];
  const seen = new Set<string>();
  const add = (heard: string, fixed: string) => {
    const k = fixed.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    found.push({ heard, fixed });
  };
  const bw = b.slice(window.from, window.to);

  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    if (op.kind === "same") {
      // A case-only change counts when it is a term's spelling: "Github" → "GitHub", "api" → "API".
      const was = a[op.a]!.text;
      const now = bw[op.b]!.text;
      if (was !== now && looksLikeTerm(now) && !looksLikeTerm(was)) add(was, now);
      i++;
      continue;
    }
    // A run of changes between two unchanged words.
    let j = i;
    const as: number[] = [];
    const bs: number[] = [];
    while (j < ops.length && ops[j]!.kind !== "same") {
      const o = ops[j]!;
      if (o.a >= 0) as.push(o.a);
      if (o.b >= 0) bs.push(o.b);
      j++;
    }
    i = j;
    if (!as.length || !bs.length || as.length > MAX_SPAN || bs.length > MAX_SPAN) continue;
    const heard = inserted.slice(a[as[0]!]!.start, a[as.at(-1)!]!.end);
    const fixed = field.slice(bw[bs[0]!]!.start, bw[bs.at(-1)!]!.end);
    if (worthSuggesting(heard, fixed, sentenceStart(field, bw[bs[0]!]!.start))) add(heard, fixed);
  }
  return found;
}

/** Corrections that aren't terms already (compared without case). */
export function newTerms(corrections: Correction[], terms: string[]): Correction[] {
  const known = new Set(terms.map((t) => t.trim().toLowerCase()));
  return corrections.filter((c) => !known.has(c.fixed.toLowerCase()));
}

// ── Where in the field our text is ──────────────────────────────────────

/**
 * The part of the field's words to align with the inserted ones: around the offset most of the
 * inserted text's word pairs (or single words, for a short or heavily edited text) agree on.
 */
function locate(a: Word[], b: Word[]): { from: number; to: number } | null {
  for (const n of [3, 2, 1]) {
    if (a.length < n) continue;
    const at = new Map<string, number[]>();
    for (let j = 0; j + n <= b.length; j++) {
      const k = gram(b, j, n);
      const list = at.get(k);
      if (list) list.push(j);
      else at.set(k, [j]);
    }
    const votes = new Map<number, number>();
    for (let i = 0; i + n <= a.length; i++) {
      for (const j of at.get(gram(a, i, n)) ?? []) votes.set(j - i, (votes.get(j - i) ?? 0) + 1);
    }
    let best: number | null = null;
    for (const [offset, count] of votes) if (best === null || count > votes.get(best)! || (count === votes.get(best)! && offset < best)) best = offset;
    if (best === null) continue;
    // Room for words the user added or removed around and inside the text.
    const slack = Math.ceil(a.length / 2) + 10;
    return { from: Math.max(0, best - slack), to: Math.min(b.length, best + a.length + slack) };
  }
  return null;
}

const gram = (w: Word[], i: number, n: number) => w.slice(i, i + n).map((x) => x.key).join(" ");

// ── Aligning words ──────────────────────────────────────────────────────

type Op = { kind: "same"; a: number; b: number } | { kind: "change"; a: number; b: number };

/**
 * Edit-distance alignment of all of `a` against a stretch of `b` (the field's words before and after
 * our text are free). Ops in order; a deleted word has b = -1, an added one a = -1.
 */
function align(a: Word[], b: Word[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const cost = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) cost[i * w] = i;
  // cost[0][j] = 0: skipping the field's words before our text is free.
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = cost[(i - 1) * w + j - 1]! + (a[i - 1]!.key === b[j - 1]!.key ? 0 : 1);
      cost[i * w + j] = Math.min(sub, cost[(i - 1) * w + j]! + 1, cost[i * w + j - 1]! + 1);
    }
  }
  // Skipping the field's words after our text is free too: end where the cost is lowest.
  let j = 0;
  // On a tie the longer stretch wins: words replaced rather than deleted plus unrelated text after.
  for (let k = 1; k <= m; k++) if (cost[n * w + k]! <= cost[n * w + j]!) j = k;
  let i = n;
  const ops: Op[] = [];
  while (i > 0) {
    const here = cost[i * w + j]!;
    if (j > 0 && here === cost[(i - 1) * w + j - 1]! + (a[i - 1]!.key === b[j - 1]!.key ? 0 : 1)) {
      ops.push({ kind: a[i - 1]!.key === b[j - 1]!.key ? "same" : "change", a: i - 1, b: j - 1 });
      i--;
      j--;
    } else if (here === cost[(i - 1) * w + j]! + 1) {
      ops.push({ kind: "change", a: i - 1, b: -1 });
      i--;
    } else {
      ops.push({ kind: "change", a: -1, b: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

// ── Is it a term? ───────────────────────────────────────────────────────

/** Spelled like a name or an identifier: a capital inside ("GitHub"), all capitals ("API"), or a digit with letters ("T3"). */
function looksLikeTerm(word: string): boolean {
  return /\p{Ll}\p{Lu}/u.test(word) || (/^\p{Lu}{2,}$/u.test(word.replace(/[^\p{L}]/gu, "")) && word.length >= 2) || (/\p{N}/u.test(word) && /\p{L}/u.test(word));
}

/** Nothing but spaces, quotes or brackets since the start of the text or the end of a sentence. */
function sentenceStart(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /[\s"«“(]/u.test(text[i]!)) i--;
  return i < 0 || /[.!?…:]/u.test(text[i]!);
}

/** `atSentenceStart`: a capital first letter there says nothing about the word. */
function worthSuggesting(heard: string, fixed: string, atSentenceStart: boolean): boolean {
  if (fixed.length < 2 || fixed.length > MAX_TERM_LENGTH) return false;
  if (!/\p{L}/u.test(fixed)) return false; // numbers: "2" → "3" is a change of mind, not a term
  if (NOT_TERMS.has(fixed.toLowerCase())) return false;
  if (heard.toLowerCase() === fixed.toLowerCase()) return looksLikeTerm(fixed) && !looksLikeTerm(heard);
  // Ordinary lowercase words in the same script are typo fixes or a different word, not terms;
  // a term has Latin letters in Cyrillic speech, digits, or capitals.
  const latin = /\p{Script=Latin}/u.test(fixed);
  const sameScript = latin === /\p{Script=Latin}/u.test(heard);
  const marked = atSentenceStart ? /.\p{Lu}|\p{N}/u.test(fixed) : /\p{Lu}|\p{N}/u.test(fixed);
  if (sameScript && !marked) return false;
  if (sameScript && otherEnding(heard, fixed)) return false;
  return soundsAlike(heard, fixed);
}

/**
 * The same word with another ending, a grammar fix rather than a spelling: "Иваном" → "Ивановым".
 * "Ильязу" → "Ильясу" is not: a letter changed, the length stayed.
 */
function otherEnding(heard: string, fixed: string): boolean {
  const x = heard.toLowerCase();
  const y = fixed.toLowerCase();
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  const tails = [x.length - p, y.length - p];
  return p >= 3 && tails[0] !== tails[1] && Math.min(...tails) <= 2;
}

// Rough Latin spelling of Russian letters, then a few English spellings folded together, so that
// "постхок" and "PostHog", "клод" and "Claude" end up close.
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "",
  ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
};

/** A rough sound of the word: lowercase Latin letters and digits. */
export function sound(text: string): string {
  let s = [...text.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("");
  s = s.replace(/[^a-z0-9]/g, "");
  return s
    .replace(/ph/g, "f")
    .replace(/ck|q|c(?=[aoukrlt]|$)/g, "k")
    .replace(/c/g, "s")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")
    .replace(/[yj]/g, "i")
    .replace(/(.)\1+/g, "$1");
}

const consonants = (s: string) => s.replace(/[aeiou]/g, "");

function similarity(x: string, y: string): number {
  if (!x.length || !y.length) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function levenshtein(x: string, y: string): number {
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row.push(Math.min(prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1), prev[j]! + 1, row[j - 1]! + 1));
    prev = row;
  }
  return prev[y.length]!;
}

/** The two sound alike: close as rough Latin spellings, or with the same consonants. */
export function soundsAlike(heard: string, fixed: string): boolean {
  const x = sound(heard);
  const y = sound(fixed);
  if (similarity(x, y) >= 0.6) return true;
  const cx = consonants(x);
  const cy = consonants(y);
  return cx.length >= 2 && similarity(cx, cy) >= 0.75;
}
