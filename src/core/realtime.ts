import { toBase64 } from "./audio";
import { SilenceGate } from "./silence";
import { t } from "./i18n";
import type { Settings } from "./types";

/** The slice of the WebSocket API we use — satisfied by browsers, React Native and the `ws` package. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

const OPEN = 1;

export interface RealtimeHandlers {
  onConnected?: () => void;
  /** More text at the end of what was shown so far. */
  onDelta?: (text: string) => void;
  /** The text shown so far changed, not only grew (Gemini revises its guess as you speak): show this instead. */
  onRevise?: (text: string) => void;
  onCompleted?: (text: string) => void;
  onError?: (message: string) => void;
}

/** A streaming transcription session, whichever provider runs it (this file: OpenAI; gemini.ts: Gemini). */
export interface LiveSession {
  readonly createdAt: number;
  connected: boolean;
  failure: string | null;
  handlers: RealtimeHandlers;
  /** Still worth handing to a new dictation. */
  readonly usable: boolean;
  /** Starts the turn; audio may follow at once. */
  configure(s: Settings): void;
  append(pcm: Uint8Array): void;
  /** The speaker is done: the final transcript follows (onCompleted). */
  commit(): void;
  close(): void;
  /**
   * Should the turn never complete: the text of the finals so far and how much of the audio, in bytes
   * from the start, they are known to cover. Without it the whole recording goes to the file model.
   */
  partial?(): { text: string; bytes: number };
  /** Audio appended but not sent, as silence the provider needn't hear (SilenceGate), in bytes. */
  readonly skippedBytes?: number;
}

/**
 * One OpenAI Realtime transcription session.
 *
 * Opening the socket takes 0.3–1 s, so callers connect ahead of time and keep the
 * session idle until speech starts (idle sessions carry no audio and cost nothing).
 * Anything sent before the socket opens is queued and flushed in order.
 * Long silence isn't sent (SilenceGate): the audio is billed by the second.
 */
export class RealtimeSession implements LiveSession {
  readonly createdAt = Date.now();
  connected = false;
  failure: string | null = null;
  handlers: RealtimeHandlers = {};

  private readonly socket: SocketLike;
  private readonly queue: string[] = [];
  private closedByUs = false;
  private readonly gate = new SilenceGate();

  /** url and service: another service that speaks the same events (nemotron.ts). */
  constructor(
    factory: SocketFactory,
    url = REALTIME_TRANSCRIPTION_URL,
    private readonly service = "OpenAI",
  ) {
    this.socket = factory(url);
    this.socket.onopen = () => {
      this.connected = true;
      for (const msg of this.queue.splice(0)) this.socket.send(msg);
      this.opened();
      this.handlers.onConnected?.();
    };
    this.socket.onmessage = (ev) => this.handle(String(ev.data));
    this.socket.onerror = () => this.fail(t().errors.cannotReach(this.service));
    this.socket.onclose = (ev) => {
      if (!this.closedByUs) this.fail(t().errors.connectionClosed(ev.reason ?? ""));
    };
  }

  /** Still worth handing to a new dictation. */
  get usable(): boolean {
    return this.failure === null && !this.closedByUs;
  }

  configure(s: Pick<Settings, "liveModel" | "delay" | "languages" | "prompt" | "keywords">): void {
    const transcription: Record<string, unknown> = { model: s.liveModel, delay: s.delay };
    if (s.languages.length) transcription.languages = s.languages;
    if (s.prompt.trim()) transcription.prompt = s.prompt.trim();
    // The API rejects keywords containing <, > or line breaks.
    const keywords = s.keywords.map((k) => k.trim()).filter((k) => k && !/[<>\r\n]/.test(k));
    if (keywords.length) transcription.keywords = keywords;
    this.send({
      type: "session.update",
      session: {
        type: "transcription",
        audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription, turn_detection: null } },
      },
    });
  }

  append(pcm: Uint8Array): void {
    for (const part of this.gate.pass(pcm)) this.send({ type: "input_audio_buffer.append", audio: toBase64(part) });
  }

  get skippedBytes(): number {
    return this.gate.skipped;
  }

  commit(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  /** The socket is open and the queue sent. */
  protected opened(): void {}

  protected send(msg: object): void {
    const json = JSON.stringify(msg);
    if (this.socket.readyState === OPEN) this.socket.send(json);
    else this.queue.push(json);
  }

  private fail(message: string): void {
    if (this.failure !== null || this.closedByUs) return;
    this.failure = message;
    this.handlers.onError?.(message);
  }

  private handle(raw: string): void {
    let msg: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "conversation.item.input_audio_transcription.delta":
        this.handlers.onDelta?.(msg.delta ?? "");
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.handlers.onCompleted?.(msg.transcript ?? "");
        break;
      case "error":
        this.fail(msg.error?.message ?? t().errors.providerError(this.service));
        break;
    }
  }
}
