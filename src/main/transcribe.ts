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
    const spare = this.spare;
    const s =
      spare?.provider === provider && spare.session.usable && Date.now() - spare.session.createdAt < SessionPool.MAX_AGE_MS[provider]
        ? spare.session
        : null;
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

/**
 * Gemini takes a saved recording at most this many times faster than real time. Sent all at once,
 * its live model transcribes the first second, ends the turn and closes with "Resource has been
 * exhausted" (Tier 1 allows 10,000 audio tokens, ~6.5 min, a minute); 4× went through whole for a
 * 5.5-minute recording (measured).
 */
const GEMINI_LIVE_SPEEDUP = 4;

/** Gemini replays one at a time: two at 4× would be over the limit together. */
let geminiReplays: Promise<unknown> = Promise.resolve();

/** Re-runs the live model over a saved recording, sending it faster than real time. */
export function transcribeLive(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  if (settings.provider !== "gemini") return replay(apiKey, pcm, settings);
  const run = geminiReplays.then(() => replay(apiKey, pcm, settings));
  geminiReplays = run.catch(() => {});
  return run;
}

function replay(apiKey: string, pcm: Buffer, settings: Settings): Promise<string> {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const s = openLive(settings.provider, apiKey);
    const timer = setTimeout(() => {
      stopped = true;
      s.close();
      reject(new Error(t().errors.timeout(PROVIDERS[settings.provider].name)));
    }, 60_000 + pcm.byteLength / BYTES_PER_MS / 2);
    s.handlers = {
      onCompleted: (text) => {
        stopped = true;
        clearTimeout(timer);
        s.close();
        resolve(text);
      },
      onError: (msg) => {
        stopped = true;
        clearTimeout(timer);
        s.close();
        reject(new Error(msg));
      },
    };
    s.configure({ ...settings, delay: "high" });
    const chunk = 24_000 * 2; // 1 s per message
    if (settings.provider !== "gemini") {
      for (let i = 0; i < pcm.byteLength; i += chunk) s.append(pcm.subarray(i, i + chunk));
      s.commit();
      return;
    }
    let i = 0;
    const next = () => {
      if (stopped) return;
      if (i >= pcm.byteLength) return s.commit();
      s.append(pcm.subarray(i, i + chunk));
      i += chunk;
      setTimeout(next, 1000 / GEMINI_LIVE_SPEEDUP);
    };
    next();
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
    const request = JSON.stringify({
      model: models(settings).file,
      // Interactions are kept on Google's side by default; recordings stay on this machine.
      store: false,
      input: [{ type: "audio", mime_type: "audio/wav", data: Buffer.from(wav(part)).toString("base64") }],
      ...(Object.keys(config).length && { generation_config: { transcription_config: config } }),
    });
    let res: Response;
    let first: GeminiInteraction | undefined;
    for (let attempt = 0; ; attempt++) {
      res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: request,
      });
      const body = (await res.json().catch(() => ({}))) as GeminiInteraction | GeminiInteraction[];
      // Errors come wrapped in an array here, unlike on :generateContent.
      first = Array.isArray(body) ? body[0] : body;
      // Tier 1 takes 10,000 audio tokens (~6.5 min) a minute, so the parts of a long recording run
      // into the limit; the error says when to come back ("Please retry in 8s").
      if (res.status !== 429 || attempt === 2) break;
      const wait = Number(/retry in ([\d.]+)\s*s/i.exec(first?.error?.message ?? "")?.[1] ?? 20);
      await new Promise((r) => setTimeout(r, Math.min(wait + 1, 60) * 1000));
    }
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
