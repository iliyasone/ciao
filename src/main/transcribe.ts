import WebSocket from "ws";
import { BYTES_PER_MS, level, wavHeader } from "../core/audio";
import { GeminiLiveSession, vocabulary } from "../core/gemini";
import { t } from "../core/i18n";
import { models, PROVIDERS } from "../core/providers";
import { RealtimeSession, type LiveSession, type SocketLike } from "../core/realtime";
import type { Provider, Settings } from "../core/types";

export function openLive(provider: Provider, apiKey: string): LiveSession {
  if (provider === "gemini")
    // The key goes in a header, not ?key=: query strings end up in logs.
    return new GeminiLiveSession((url) => new WebSocket(url, { headers: { "x-goog-api-key": apiKey } }) as unknown as SocketLike);
  return new RealtimeSession((url) => new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } }) as unknown as SocketLike);
}

/** Keeps one connected session in reserve so dictation starts streaming instantly. */
export class SessionPool {
  private spare: { provider: Provider; session: LiveSession } | null = null;
  // Gemini drops a socket that has waited ~5 min without a setup (measured: fine after 4 min, gone
  // after 5.5), and a live session lasts at most 10 min.
  private static readonly MAX_AGE_MS: Record<Provider, number> = { openai: 10 * 60_000, gemini: 2 * 60_000 };

  constructor(
    private readonly provider: () => Provider,
    private readonly apiKey: (provider: Provider) => string | null,
  ) {}

  refill(): void {
    const s = this.spare;
    const provider = this.provider();
    if (s && s.provider === provider && s.session.usable && Date.now() - s.session.createdAt < SessionPool.MAX_AGE_MS[provider]) return;
    s?.session.close();
    this.spare = null;
    const key = this.apiKey(provider);
    if (key) this.spare = { provider, session: openLive(provider, key) };
  }

  take(): LiveSession | null {
    const provider = this.provider();
    const s = this.spare?.provider === provider && this.spare.session.usable ? this.spare.session : null;
    if (!s) this.spare?.session.close();
    this.spare = null;
    const key = this.apiKey(provider);
    const session = s ?? (key ? openLive(provider, key) : null);
    this.refill();
    return session;
  }

  close(): void {
    this.spare?.session.close();
    this.spare = null;
  }
}

/** Re-runs the live model over a saved recording, sending it faster than real time. */
export function transcribeLive(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = openLive(settings.provider, apiKey);
    const timer = setTimeout(() => {
      s.close();
      reject(new Error(t().errors.timeout(PROVIDERS[settings.provider].name)));
    }, 60_000 + pcm.byteLength / BYTES_PER_MS / 2);
    s.handlers = {
      onCompleted: (text) => {
        clearTimeout(timer);
        s.close();
        resolve(text);
      },
      onError: (msg) => {
        clearTimeout(timer);
        s.close();
        reject(new Error(msg));
      },
    };
    s.configure({ ...settings, delay: "high" });
    const chunk = 24_000 * 2; // 1 s per message
    for (let i = 0; i < pcm.byteLength; i += chunk) s.append(pcm.subarray(i, i + chunk));
    s.commit();
  });
}

// The file endpoint takes up to 25 MB, i.e. ~8.5 min of 24 kHz PCM16. Longer recordings are
// split at the quietest moment near each boundary so no word is cut in half.
// Gemini takes the audio inline as base64 in a JSON body; 4 min is ~15 MB of it.
const MAX_PART_MS = 8 * 60_000;
const GEMINI_MAX_PART_MS = 4 * 60_000;
const SEARCH_MS = 10_000;

function splitPcm(pcm: Buffer, maxPartMs = MAX_PART_MS): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  const maxBytes = maxPartMs * BYTES_PER_MS;
  while (pcm.byteLength - start > maxBytes) {
    const hardEnd = start + maxBytes;
    const step = 100 * BYTES_PER_MS;
    let cut = hardEnd;
    let quietest = Infinity;
    for (let at = hardEnd - SEARCH_MS * BYTES_PER_MS; at < hardEnd; at += step) {
      const l = level(pcm.subarray(at, at + step));
      if (l < quietest) {
        quietest = l;
        cut = at;
      }
    }
    parts.push(pcm.subarray(start, cut));
    start = cut;
  }
  parts.push(pcm.subarray(start));
  return parts;
}

function wav(pcm: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(wavHeader(pcm.byteLength));
  out.set(pcm, 44);
  return out;
}

/** Transcribes a whole recording with the (more accurate, cheaper) file model. */
export async function transcribeFile(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  if (settings.provider === "gemini") return transcribeFileGemini(apiKey, pcm, settings);
  const texts: string[] = [];
  for (const part of splitPcm(pcm)) {
    const form = new FormData();
    form.append("file", new Blob([wav(part)], { type: "audio/wav" }), "audio.wav");
    form.append("model", settings.fileModel);
    if (settings.languages[0]) form.append("language", settings.languages[0]);
    const hints = [settings.prompt.trim(), settings.keywords.length ? `Термины: ${settings.keywords.join(", ")}.` : ""].filter(Boolean).join(" ");
    if (hints) form.append("prompt", hints);
    // Continuity across parts.
    if (texts.length) form.set("prompt", `${hints} ${texts.at(-1)!.slice(-400)}`.trim());

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? t().errors.status("OpenAI", res.status));
    texts.push((body.text ?? "").trim());
  }
  return texts.filter(Boolean).join(" ");
}

/**
 * gemini-3.5-transcribe through the Interactions API: the only Gemini endpoint where smart mode
 * works (on :generateContent it parses, then returns an empty text). Never add language codes,
 * see core/gemini.ts.
 */
async function transcribeFileGemini(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  const config: Record<string, unknown> = {};
  if (settings.smart) config.mode = "smart";
  const terms = vocabulary(settings.keywords);
  if (terms.length) config.custom_vocabulary = terms;
  const texts: string[] = [];
  for (const part of splitPcm(pcm, GEMINI_MAX_PART_MS)) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: models(settings).file,
        input: [{ type: "audio", mime_type: "audio/wav", data: Buffer.from(wav(part)).toString("base64") }],
        ...(Object.keys(config).length && { generation_config: { transcription_config: config } }),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as GeminiInteraction | GeminiInteraction[];
    // Errors come wrapped in an array here, unlike on :generateContent.
    const first = Array.isArray(body) ? body[0] : body;
    if (!res.ok) throw new Error(first?.error?.message ?? t().errors.status("Gemini", res.status));
    if (first?.status !== "completed") throw new Error(first?.error?.message ?? t().errors.status("Gemini", first?.status ?? res.status));
    const text = (first.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .join("");
    texts.push(text.trim());
  }
  return texts.filter(Boolean).join(" ");
}

interface GeminiInteraction {
  status?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  error?: { message?: string };
}
