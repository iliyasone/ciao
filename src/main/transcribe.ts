import WebSocket from "ws";
import { BYTES_PER_MS, level, wavHeader } from "../core/audio";
import { RealtimeSession, type SocketLike } from "../core/realtime";
import type { Settings } from "../core/types";

export function openRealtime(apiKey: string): RealtimeSession {
  return new RealtimeSession((url) => new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } }) as unknown as SocketLike);
}

/** Keeps one connected session in reserve so dictation starts streaming instantly. */
export class SessionPool {
  private spare: RealtimeSession | null = null;
  private static readonly MAX_AGE_MS = 10 * 60_000;

  constructor(private readonly apiKey: () => string | null) {}

  refill(): void {
    const s = this.spare;
    if (s && s.usable && Date.now() - s.createdAt < SessionPool.MAX_AGE_MS) return;
    s?.close();
    this.spare = null;
    const key = this.apiKey();
    if (key) this.spare = openRealtime(key);
  }

  take(): RealtimeSession | null {
    const s = this.spare?.usable ? this.spare : null;
    this.spare = null;
    const session = s ?? (this.apiKey() ? openRealtime(this.apiKey()!) : null);
    this.refill();
    return session;
  }

  close(): void {
    this.spare?.close();
    this.spare = null;
  }
}

/** Re-runs the live model over a saved recording, sending it faster than real time. */
export function transcribeLive(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = openRealtime(apiKey);
    const timer = setTimeout(() => {
      s.close();
      reject(new Error("OpenAI не ответил вовремя"));
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
const MAX_PART_MS = 8 * 60_000;
const SEARCH_MS = 10_000;

function splitPcm(pcm: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  const maxBytes = MAX_PART_MS * BYTES_PER_MS;
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

/** Transcribes a whole recording with the (more accurate, cheaper) file model. */
export async function transcribeFile(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  const texts: string[] = [];
  for (const part of splitPcm(pcm)) {
    const form = new FormData();
    const wav = new Uint8Array(44 + part.byteLength);
    wav.set(wavHeader(part.byteLength));
    wav.set(part, 44);
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
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
    if (!res.ok) throw new Error(body.error?.message ?? `OpenAI ответил ${res.status}`);
    texts.push((body.text ?? "").trim());
  }
  return texts.filter(Boolean).join(" ");
}
