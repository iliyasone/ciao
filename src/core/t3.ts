import { appLabel } from "./apps";

// T3 mode (Settings → T3 Code): dictation for the T3 Code app's chat box. T3 Code tells other apps
// nothing about which chat is open (its window title is always the app's name), so the text goes in
// by pasting into the T3 Code window in front, and only there.

/** The T3 Code app, by its process ("T3 Code (Nightly)" on Windows and macOS, "t3code" on Linux), or its web app in a browser tab. */
export function isT3Code(w: { process: string; title: string }): boolean {
  return /^t3[ -]?code\b/i.test(w.process.replace(/\.exe$/i, "")) || (appLabel(w.process) === "browser" && /^T3 Code\b/.test(w.title));
}

/** The T3 Code app's process, for the input helper's "activate" (a case-insensitive regex). */
export const T3_PROCESS = "^t3[ -]?code";

/**
 * AI chats a T3-mode dictation stays in instead of going to T3 Code: started with one in front, it works
 * as without T3 mode (pasted where you are), and the card shows the chat's icon (public/chats/<id>.png).
 * Known in a browser by the page's address (see InputHelper.page) or, failing that, by the window title,
 * and by their own desktop apps. A conversation in ChatGPT is titled by its subject alone: there only the
 * address tells.
 */
export const AI_CHATS = {
  chatgpt: { name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], titles: ["ChatGPT"] },
  claude: { name: "Claude", hosts: ["claude.ai"], titles: ["Claude"] },
  gemini: { name: "Gemini", hosts: ["gemini.google.com", "aistudio.google.com"], titles: ["Gemini", "Google Gemini", "Google AI Studio"] },
  perplexity: { name: "Perplexity", hosts: ["perplexity.ai"], titles: ["Perplexity"] },
  grok: { name: "Grok", hosts: ["grok.com"], titles: ["Grok"] },
  deepseek: { name: "DeepSeek", hosts: ["chat.deepseek.com"], titles: ["DeepSeek"] },
  copilot: { name: "Copilot", hosts: ["copilot.microsoft.com", "copilot.com"], titles: ["Microsoft Copilot", "Copilot"] },
} as const;

export type AiChat = keyof typeof AI_CHATS;

/** The AI chat in window `w` (`url`: the address of the page it shows, if known), or null. */
export function aiChat(w: { process: string; title: string }, url: string | null): AiChat | null {
  const app = appLabel(w.process);
  if (app === "chatgpt" || app === "claude") return app; // their desktop apps
  // No process at all: a Wayland desktop, which names no window; then only the address tells.
  if (app !== "browser" && w.process) return null;
  const ids = Object.keys(AI_CHATS) as AiChat[];
  let host = "";
  try {
    host = url ? new URL(url).hostname.toLowerCase() : "";
  } catch {
    // not an address after all: go by the title
  }
  if (host) return ids.find((id) => AI_CHATS[id].hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
  if (isT3Code(w)) return null; // T3 Code's web app
  // "Topic - Claude - Google Chrome", "Google Gemini — Mozilla Firefox", "ChatGPT and 3 more pages - Microsoft Edge".
  const parts = w.title.split(/\s[-–—|]\s/).map((part) => part.replace(/ and \d+ more pages?$/, "").trim());
  return ids.find((id) => parts.some((part) => (AI_CHATS[id].titles as readonly string[]).includes(part))) ?? null;
}

/** The prompt as pasted: the user's words between the optional prefix and suffix (say, "Клауди," to get a spoken answer). */
export function t3Prompt(text: string, prefix: string, suffix: string): string {
  return [prefix.trim(), text, suffix.trim()].filter(Boolean).join(" ");
}

/** How many times `text` shows up in the field's text, whatever the field did to spaces and line breaks (by its last 80 characters). */
export function occurrences(field: string, text: string): number {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const want = squash(text).slice(-80);
  if (!want) return 0;
  const hay = squash(field);
  let n = 0;
  for (let i = hay.indexOf(want); i >= 0; i = hay.indexOf(want, i + 1)) n++;
  return n;
}
