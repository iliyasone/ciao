import { t } from "./i18n";
import { PROVIDERS } from "./providers";
import type { Provider } from "./types";
import type { RememberCommand } from "./voiceCommands";

// The term a "чао, запомни слово …" command asked for (core/voiceCommands.ts). A transcription
// model has no idea of the command, so what it wrote may be the term misheard, in Cyrillic though
// meant in Latin, or spelled letter by letter; a small text model of the same provider, with the
// same key, writes it the usual way. Only the words of the command are sent.

/** Fast and cheap text models: ~0.5 s, and both resolved every spelled and misheard case tried (PostHog, npm, WSL, Kubernetes). */
export const TERM_MODELS: Record<Provider, string> = {
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.5-flash-lite",
};

export const TERM_PROMPT = `The user is dictating and asked the app to remember a term for the speech recognizer's vocabulary. You get what the recognizer heard after the command: the term, possibly misheard, written in Cyrillic though meant in Latin, or spelled out letter by letter (in Russian or English letter names: "пэ, о, эс, тэ", "эйч", "дабл ю", "P-O-S-T").
Answer with the term only, written the way it is normally written: the script, capitalization and spacing of a known product, library, command or name (PostHog, Kubernetes, pnpm, Next.js). Spelled letters are joined into the word, cased as that word is usually written. A Russian word meant in Russian stays in Cyrillic. No quotes, no explanation, nothing else. If there is no term in it, answer with an empty string.`;

/** Longer than this, the answer is not a term but the model talking. */
const MAX_TERM = 60;
/** A model that takes longer is not coming: the word as heard is kept instead (fallbackTerm). */
const TIMEOUT_MS = 10_000;

/**
 * The term as heard, when that is already how it's written: one Latin word with a recognizer's
 * deliberate spelling in it (inner capitals, digits, dots: "PostHog", "Next.js", "gpt-5", "API").
 * Anything else, Cyrillic, several words or "Posthog" included, goes to the model.
 */
export function plainTerm(c: RememberCommand): string | null {
  const w = c.heard;
  if (c.spelled || !/^[\p{Script=Latin}\p{N}.+#_'’-]+$/u.test(w) || !/\p{L}/u.test(w)) return null;
  return /.\p{Lu}|\p{N}|[.+#_-]/u.test(w) || /^\p{Lu}{2,}$/u.test(w) ? w : null;
}

/** When the model can't be asked (no network, an error): a short term as heard, or Latin letters joined. */
export function fallbackTerm(c: RememberCommand): string | null {
  if (c.spelled) {
    const letters = c.heard.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return letters.every((l) => /^[\p{Script=Latin}\p{N}]$/u.test(l)) ? letters.join("") : null;
  }
  return c.heard && c.heard.split(/\s+/).length <= 3 ? c.heard : null;
}

/** The model's answer as a term: one line, without quotes or a final period ("A.I." keeps it); null if none. */
export function cleanTerm(answer: string): string | null {
  const unquote = (s: string) => s.replace(/^[\s"'«“`]+|[\s"'»”`]+$/gu, "");
  let term = unquote(answer);
  // «PostHog». → PostHog
  if (!/^(?:\p{L}\.)+$/u.test(term)) term = unquote(term.replace(/\.$/, ""));
  return term && term.length <= MAX_TERM && !/[\r\n<>]/.test(term) ? term : null;
}

/** Asks the provider's text model for the term; throws on a network or API error. */
export async function termFromModel(provider: Provider, apiKey: string, heard: string): Promise<string | null> {
  const name = PROVIDERS[provider].name;
  const res =
    provider === "gemini"
      ? await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TERM_MODELS.gemini}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: TERM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: heard }] }],
            generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
          }),
        })
      : await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            model: TERM_MODELS.openai,
            reasoning_effort: "none",
            messages: [
              { role: "system", content: TERM_PROMPT },
              { role: "user", content: heard },
            ],
          }),
        });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  if (!res.ok) throw new Error(body.error?.message ?? t().errors.status(name, res.status));
  const answer =
    provider === "gemini"
      ? (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("")
      : (body.choices?.[0]?.message?.content ?? "");
  return cleanTerm(answer);
}

/**
 * The term a command asked for: as heard when that's enough, else from the model (null when it found
 * none: nothing is added), else, when the model can't be reached, a fallback.
 */
export async function resolveTerm(provider: Provider, apiKey: string, c: RememberCommand): Promise<string | null> {
  if (!c.heard) return null;
  const plain = plainTerm(c);
  if (plain) return plain;
  try {
    return await termFromModel(provider, apiKey, c.heard);
  } catch (e) {
    console.warn("term from model:", (e as Error).message);
    return fallbackTerm(c);
  }
}

/**
 * The terms with `term` added; one differing only in case is replaced (the user just said how it is
 * written). Unchanged (the same array) when it's there already.
 */
export function addTerm(keywords: string[], term: string): string[] {
  if (keywords.some((k) => k.trim() === term)) return keywords;
  const lower = term.toLocaleLowerCase();
  return [...keywords.filter((k) => k.trim().toLocaleLowerCase() !== lower), term];
}
