import type { Provider, Settings } from "./types";

/** Who transcribes: the models each provider uses, and where its API key lives. */
export interface ProviderInfo {
  name: string;
  /** Who runs it, shown next to the name in Settings. */
  company: string;
  /** Streams while you speak. */
  liveModel: string;
  /** Re-transcribes a whole recording ("More accurate", and when the live transcript failed). */
  fileModel: string;
  /** Env var and file (next to the settings) holding the key. */
  keyEnv: string;
  keyFile: string;
  keyPlaceholder: string;
  /**
   * The "key" is the access token of a ChatGPT account, saved on signing in (main/chatgpt.ts): Settings
   * shows a sign-in instead of a key field. It syncs like a key; the device signed in renews it.
   */
  signIn?: boolean;
  /** Runs on this device (main/local.ts): no key, no proxy, no internet. */
  local?: boolean;
}

/** In the order Settings lists them. */
export const PROVIDERS: Record<Provider, ProviderInfo> = {
  gemini: {
    name: "Gemini",
    company: "Google",
    liveModel: "gemini-3.5-transcribe-live",
    fileModel: "gemini-3.5-transcribe",
    keyEnv: "GEMINI_API_KEY",
    keyFile: "gemini-key.txt",
    keyPlaceholder: "AQ.… / https://…?key=…",
  },
  openai: {
    name: "OpenAI",
    company: "OpenAI",
    liveModel: "gpt-live-transcribe",
    fileModel: "gpt-transcribe",
    keyEnv: "OPENAI_API_KEY",
    keyFile: "openai-key.txt",
    keyPlaceholder: "sk-…",
  },
  // .wave runs it; there is no file model, so "More accurate" replays the recording at its own speed.
  nemotron: {
    name: "Nemotron",
    company: "NVIDIA",
    liveModel: "nemotron-asr-streaming",
    fileModel: "nemotron-asr-streaming",
    keyEnv: "DOTWAVE_API_KEY",
    keyFile: "dotwave-key.txt",
    keyPlaceholder: "wk_…",
  },
  // chatgpt.com's own dictation, free with a ChatGPT account: not a public API (core/chatgpt.ts).
  chatgpt: {
    name: "ChatGPT",
    company: "OpenAI",
    liveModel: "chatgpt-dictation",
    fileModel: "chatgpt-transcribe",
    keyEnv: "CHATGPT_ACCESS_TOKEN",
    keyFile: "chatgpt-token.txt",
    keyPlaceholder: "",
    signIn: true,
  },
  // Telegram's on-device recognizer (tinyasr, GPL-3.0-or-later): native/asr, models fetched by scripts/fetch-tinyasr.mjs.
  local: {
    name: "tinyasr",
    company: "Telegram",
    liveModel: "tinyasr-en-ru-uk",
    fileModel: "tinyasr-en-ru-uk",
    keyEnv: "",
    keyFile: "",
    keyPlaceholder: "",
    local: true,
  },
};

/** The models in use. OpenAI's can be overridden in config.json (liveModel, fileModel); Gemini's are fixed. */
export function models(s: Pick<Settings, "provider" | "liveModel" | "fileModel">): { live: string; file: string } {
  if (s.provider === "openai") return { live: s.liveModel, file: s.fileModel };
  return { live: PROVIDERS[s.provider].liveModel, file: PROVIDERS[s.provider].fileModel };
}
