import { toBase64 } from "./audio";
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
  onDelta?: (text: string) => void;
  onCompleted?: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * One OpenAI Realtime transcription session.
 *
 * Opening the socket takes 0.3–1 s, so callers connect ahead of time and keep the
 * session idle until speech starts (idle sessions carry no audio and cost nothing).
 * Anything sent before the socket opens is queued and flushed in order.
 */
export class RealtimeSession {
  readonly createdAt = Date.now();
  connected = false;
  failure: string | null = null;
  handlers: RealtimeHandlers = {};

  private readonly socket: SocketLike;
  private readonly queue: string[] = [];
  private closedByUs = false;

  constructor(factory: SocketFactory) {
    this.socket = factory(REALTIME_TRANSCRIPTION_URL);
    this.socket.onopen = () => {
      this.connected = true;
      for (const msg of this.queue.splice(0)) this.socket.send(msg);
      this.handlers.onConnected?.();
    };
    this.socket.onmessage = (ev) => this.handle(String(ev.data));
    this.socket.onerror = () => this.fail("Не удалось связаться с OpenAI");
    this.socket.onclose = (ev) => {
      if (!this.closedByUs) this.fail(`Соединение закрыто${ev.reason ? `: ${ev.reason}` : ""}`);
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
    this.send({ type: "input_audio_buffer.append", audio: toBase64(pcm) });
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
        this.fail(msg.error?.message ?? "Ошибка OpenAI");
        break;
    }
  }
}
