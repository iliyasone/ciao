import type { Provider, Settings } from "./types";

/** Who transcribes: the models each provider uses, and where its API key lives. */
export interface ProviderInfo {
  name: string;
  /** Streams while you speak. */
  liveModel: string;
  /** Re-transcribes a whole recording ("More accurate", and when the live transcript failed). */
  fileModel: string;
  /** Env var and file (next to the settings) holding the key. */
  keyEnv: string;
  keyFile: string;
  keyPlaceholder: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  openai: {
    name: "OpenAI",
    liveModel: "gpt-live-transcribe",
    fileModel: "gpt-transcribe",
    keyEnv: "OPENAI_API_KEY",
    keyFile: "openai-key.txt",
    keyPlaceholder: "sk-…",
  },
  gemini: {
    name: "Gemini",
    liveModel: "gemini-3.5-transcribe-live",
    fileModel: "gemini-3.5-transcribe",
    keyEnv: "GEMINI_API_KEY",
    keyFile: "gemini-key.txt",
    keyPlaceholder: "AQ.…",
  },
};

/** The models in use. OpenAI's can be overridden in config.json (liveModel, fileModel); Gemini's are fixed. */
export function models(s: Pick<Settings, "provider" | "liveModel" | "fileModel">): { live: string; file: string } {
  if (s.provider === "openai") return { live: s.liveModel, file: s.fileModel };
  return { live: PROVIDERS[s.provider].liveModel, file: PROVIDERS[s.provider].fileModel };
}
