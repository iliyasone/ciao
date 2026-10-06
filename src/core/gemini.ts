import { SAMPLE_RATE, toBase64 } from "./audio";
import { t } from "./i18n";
import { PROVIDERS } from "./providers";
import type { LiveSession, RealtimeHandlers, SocketFactory, SocketLike } from "./realtime";
import type { Settings } from "./types";

export const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const OPEN = 1;
const AUDIO_MIME = `audio/pcm;rate=${SAMPLE_RATE}`;

/** Terms for custom_vocabulary: the same cleanup as OpenAI's keywords, at most the API's 1,000. */
export function vocabulary(keywords: string[]): string[] {
  return keywords.map((k) => k.trim()).filter((k) => k && !/[<>\r\n]/.test(k)).slice(0, 1000);
}

/**
 * One Gemini Live transcription session (gemini-3.5-transcribe-live).
 *
 * The turn is ours, not the server's: automatic voice detection is off, so a pause to think doesn't
 * end the dictation; configure() starts the turn and commit() ends it. While you speak the server
 * sends interim guesses, each replacing the last, and a final transcript per finished segment; in
 * smart mode the finals drop fillers and false starts and apply spoken corrections ("в два, нет, в
 * три" → "в три"), so a final may differ from the guesses before it.
 *
 * Never send language codes along with smart mode: on Gemini's transcription endpoints that silently
 * turns smart mode off (found by google-gemini/jot-gemini-transcribe-macOS). Without them the
 * language is detected per utterance, mixed Russian and English included.
 */
export class GeminiLiveSession implements LiveSession {
  readonly createdAt = Date.now();
  connected = false;
  failure: string | null = null;
  handlers: RealtimeHandlers = {};

  private readonly socket: SocketLike;
  private readonly queue: string[] = [];
  private closedByUs = false;
  private readonly finals: string[] = [];
  private interim = "";
  /** What onDelta/onRevise have shown so far. */
  private shown = "";
  private committed = false;
  private completed = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  /** Gemini sends JSON as binary frames: a browser-style socket needs binaryType = "arraybuffer". */
  constructor(factory: SocketFactory) {
    this.socket = factory(GEMINI_LIVE_URL);
    this.socket.onopen = () => {
      this.connected = true;
      for (const msg of this.queue.splice(0)) this.socket.send(msg);
      this.handlers.onConnected?.();
    };
    this.socket.onmessage = (ev) => this.handle(ev.data);
    this.socket.onerror = () => this.fail(t().errors.cannotReach("Gemini"));
    this.socket.onclose = (ev) => {
      if (!this.closedByUs && !this.completed) this.fail(t().errors.connectionClosed(ev.reason ?? ""));
    };
  }

  get usable(): boolean {
    return this.failure === null && !this.closedByUs;
  }

  configure(s: Pick<Settings, "smart" | "keywords">): void {
    const transcription: Record<string, unknown> = { mode: s.smart ? "SMART" : "VERBATIM" };
    const terms = vocabulary(s.keywords);
    if (terms.length) transcription.customVocabulary = terms;
    this.send({
      setup: {
        model: `models/${PROVIDERS.gemini.liveModel}`,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: transcription,
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    });
    this.send({ realtimeInput: { activityStart: {} } });
  }

  append(pcm: Uint8Array): void {
    this.send({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: AUDIO_MIME } } });
  }

  commit(): void {
    this.committed = true;
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  close(): void {
    this.closedByUs = true;
    clearTimeout(this.settleTimer);
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private send(msg: object): void {
    const json = JSON.stringify(msg);
    if (this.socket.readyState === OPEN) this.socket.send(json);
    else this.queue.push(json);
  }

  private fail(message: string): void {
    if (this.failure !== null || this.closedByUs) return;
    this.failure = message;
    this.handlers.onError?.(message);
  }

  /** Finals so far plus the current guess, as one text; shown as a delta when it only grew. */
  private show(): void {
    const text = [...this.finals, this.interim].map((x) => x.trim()).filter(Boolean).join(" ");
    if (text === this.shown) return;
    if (text.startsWith(this.shown)) this.handlers.onDelta?.(text.slice(this.shown.length));
    else this.handlers.onRevise?.(text);
    this.shown = text;
  }

  private complete(): void {
    if (this.completed) return;
    this.completed = true;
    clearTimeout(this.settleTimer);
    this.handlers.onCompleted?.(this.finals.map((x) => x.trim()).filter(Boolean).join(" "));
  }

  private handle(data: unknown): void {
    // The socket sends JSON as binary frames.
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer | Uint8Array);
    let msg: {
      error?: { message?: string };
      goAway?: unknown;
      voiceActivity?: { type?: string };
      serverContent?: {
        interimInputTranscription?: { text?: string };
        inputTranscription?: { text?: string };
        turnComplete?: boolean;
        generationComplete?: boolean;
      };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.error) return this.fail(msg.error.message ?? t().errors.providerError("Gemini"));
    if (msg.goAway && !this.committed) return this.fail(t().errors.connectionClosed("goAway"));
    // Nothing was said: after the turn ends no final comes at all (measured), only this. With
    // speech, the final arrives before it.
    if (msg.voiceActivity?.type === "ACTIVITY_END" && this.committed && !this.finals.length && !this.shown) {
      this.settleTimer = setTimeout(() => this.complete(), 500);
    }
    const content = msg.serverContent;
    if (!content) return;
    // A frame may carry both; the final wins.
    if (content.inputTranscription?.text !== undefined) {
      this.finals.push(content.inputTranscription.text);
      this.interim = "";
      this.show();
      // After the turn ended, the final is followed by generationComplete; don't hang on it.
      if (this.committed) {
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.complete(), 300);
      }
    } else if (content.interimInputTranscription?.text !== undefined) {
      this.interim = content.interimInputTranscription.text;
      this.show();
    }
    if ((content.generationComplete || content.turnComplete) && this.committed) this.complete();
  }
}
