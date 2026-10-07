import { BYTES_PER_MS, level, SAMPLE_RATE, toBase64 } from "./audio";
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
 * The server ends an activity on its own about 220 s after it started and ignores the audio after
 * that (measured: a 5.5-minute dictation lost its last 100 s), so a long dictation is cut into
 * several, each with its own final: ROLL_AFTER_MS into one, it ends at the next pause, or at
 * ROLL_BY_MS without one. The next may start only once the server reports the end (ACTIVITY_END;
 * an activityStart before that is ignored, measured), so the audio in between is held and sent
 * after it: nothing is lost. Should the server end one first, the next starts right away; then the
 * ~2 s before that are lost.
 *
 * Never send language codes along with smart mode: on Gemini's transcription endpoints that silently
 * turns smart mode off (found by google-gemini/jot-gemini-transcribe-macOS). Without them the
 * language is detected per utterance, mixed Russian and English included.
 */
export class GeminiLiveSession implements LiveSession {
  static ROLL_AFTER_MS = 150_000;
  static ROLL_BY_MS = 200_000;
  /** Quiet this long (below QUIET_LEVEL) counts as a pause to cut at. */
  private static readonly PAUSE_MS = 300;
  private static readonly QUIET_LEVEL = 400;

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
  private activityAt = 0;
  /** Finals from the activities before the current one. */
  private earlierFinals = 0;
  /** Quiet at the end of the audio so far. */
  private quietMs = 0;
  /** We ended an activity early and wait for the server to confirm; audio meanwhile is held. */
  private rolling = false;
  private held: Uint8Array[] = [];
  /** Whether any of the held audio is more than quiet. */
  private heldVoice = false;

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
    this.startActivity();
  }

  append(pcm: Uint8Array): void {
    const quiet = level(pcm) < GeminiLiveSession.QUIET_LEVEL;
    this.quietMs = quiet ? this.quietMs + pcm.byteLength / BYTES_PER_MS : 0;
    if (this.rolling) {
      this.heldVoice ||= !quiet;
      return void this.held.push(pcm);
    }
    const { ROLL_AFTER_MS, ROLL_BY_MS, PAUSE_MS } = GeminiLiveSession;
    const age = Date.now() - this.activityAt;
    if ((age >= ROLL_AFTER_MS && this.quietMs >= PAUSE_MS) || age >= ROLL_BY_MS) {
      this.rolling = true;
      this.held = [pcm];
      this.heldVoice = !quiet;
      return this.send({ realtimeInput: { activityEnd: {} } });
    }
    this.sendAudio(pcm);
  }

  /** While rolling over, the turn ends once the held audio is sent (see handle). */
  commit(): void {
    this.committed = true;
    if (!this.rolling) this.send({ realtimeInput: { activityEnd: {} } });
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

  private startActivity(): void {
    this.activityAt = Date.now();
    this.earlierFinals = this.finals.length;
    this.send({ realtimeInput: { activityStart: {} } });
  }

  private sendAudio(pcm: Uint8Array): void {
    this.send({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: AUDIO_MIME } } });
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
    // Each activity ends with this, after its final.
    if (msg.voiceActivity?.type === "ACTIVITY_END") {
      if (this.rolling) {
        this.rolling = false;
        // Released in the pause the cut was made at: the final for what was said is in, and the
        // quiet tail isn't worth another round trip.
        if (this.committed && !this.heldVoice) return this.complete();
        this.startActivity();
        for (const pcm of this.held.splice(0)) this.sendAudio(pcm);
        if (this.committed) this.send({ realtimeInput: { activityEnd: {} } });
      } else if (!this.committed) {
        // The server cut the activity short: start another, or it ignores the rest.
        this.startActivity();
      } else if (!this.interim) {
        // The turn is over and no guess awaits its final. Nothing was said in this activity, so no
        // final comes at all (measured), only this; with speech, the final arrives before it. A wait
        // already set (below) knows better.
        this.settleTimer ??= setTimeout(() => this.complete(), 500);
      }
    }
    const content = msg.serverContent;
    if (!content) return;
    // A frame may carry both; the final wins.
    if (content.inputTranscription?.text !== undefined) {
      this.finals.push(content.inputTranscription.text);
      this.interim = "";
      this.show();
      // After the turn ended, the final is followed by generationComplete; don't hang on it.
      if (this.committed && !this.rolling) {
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.complete(), 300);
      }
    } else if (content.interimInputTranscription?.text !== undefined) {
      this.interim = content.interimInputTranscription.text;
      this.show();
    }
    // While rolling over, this ends the activity cut short, not the turn.
    if ((content.generationComplete || content.turnComplete) && this.committed && !this.rolling) {
      if (this.finals.length > this.earlierFinals) return this.complete();
      // A last activity with no final is either silence or the server giving up: sent too fast, it
      // transcribes the first second, ends the turn and closes with "Resource has been exhausted" a
      // moment later (measured). Wait for that close, so it fails instead of passing for silence.
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.complete(), 1500);
    }
  }
}
