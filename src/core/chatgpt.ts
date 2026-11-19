import { BYTES_PER_MS, SAMPLE_RATE, toBase64 } from "./audio";
import { t } from "./i18n";
import type { LiveSession, RealtimeHandlers, SocketFactory, SocketLike } from "./realtime";

// ChatGPT's own dictation, as chatgpt.com uses it in its message box: not a public API. The socket
// and the file endpoint take the access token of a signed-in ChatGPT account (free accounts too),
// which chatgpt.com/api/auth/session hands out for about 10 days (main/chatgpt.ts).

export const CHATGPT_LIVE_URL = "wss://chatgpt.com/backend-api/dictation/stream?client_type=web&dictation_surface=composer";
export const CHATGPT_FILE_URL = "https://chatgpt.com/backend-api/transcribe";

/** The token goes as a sub-protocol of the socket, as chatgpt.com sends it. */
export function chatgptProtocols(token: string): string[] {
  return ["chatgpt-dictation", `openai-bearer.${token}`];
}

/** The account an access token is for and when it expires, read from the token itself (a JWT). Null for anything else. */
export function chatgptAccount(token: string): { email: string; expiresAt: number } | null {
  try {
    const part = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: number; "https://api.openai.com/profile"?: { email?: string } };
    if (typeof claims.exp !== "number") return null;
    return { email: claims["https://api.openai.com/profile"]?.email ?? "", expiresAt: claims.exp * 1000 };
  } catch {
    return null;
  }
}

const OPEN = 1;

interface Utterance {
  revision: number;
  text: string;
  final: boolean;
}

/**
 * One ChatGPT dictation stream.
 *
 * session.start configures it; audio goes in as is (it costs nothing, so silence isn't left out);
 * session.close ends it. The server finds speech itself and sends the text of each utterance as it
 * grows ("transcript.segment", the whole utterance so far, a higher revision replacing a lower one),
 * then once more as final ("transcript.final"). With session.updated "closed" every final is in.
 * The text shown is all utterances in order. In practice a dictation is one utterance however long:
 * measured, neither pauses nor the 30 s in max_utterance_duration_ms end one while audio keeps coming.
 *
 * session_ttl_ms counts from the last audio, not from the start (expires_at_ms in session.updated is
 * the last activity plus it): a dictation that keeps sending audio lasts as long as it needs
 * (measured past 10 minutes). A socket without session.start waits as long (the pool's spare).
 *
 * The server can give up on an utterance ("transcript.failed"): the live text stays on screen, and
 * at the end the session fails, so the whole recording goes to the file model (/backend-api/transcribe),
 * as chatgpt.com does with the audio it kept.
 *
 * No terms, context or language: the language is detected as you speak, mixed Russian and English included.
 */
export class ChatGPTSession implements LiveSession {
  /** chatgpt.com ends with this much silence before session.close. */
  private static readonly TAIL_MS = 250;

  readonly createdAt = Date.now();
  connected = false;
  failure: string | null = null;
  handlers: RealtimeHandlers = {};

  private readonly socket: SocketLike;
  private readonly queue: string[] = [];
  private closedByUs = false;
  private completed = false;
  private committed = false;
  /** By id, in the order spoken. */
  private readonly utterances = new Map<string, Utterance>();
  private shown = "";
  /** An utterance the server gave up on: the session fails once it is over. */
  private lost: string | null = null;

  constructor(factory: SocketFactory) {
    this.socket = factory(CHATGPT_LIVE_URL);
    this.socket.onopen = () => {
      this.connected = true;
      for (const msg of this.queue.splice(0)) this.socket.send(msg);
      this.handlers.onConnected?.();
    };
    this.socket.onmessage = (ev) => this.handle(String(ev.data));
    // The `ws` package names the refusal ("Unexpected server response: 401"); a browser's socket doesn't.
    this.socket.onerror = (ev) =>
      this.fail(/\b401\b/.test(String((ev as { message?: unknown } | null)?.message)) ? t().errors.signedOut : t().errors.cannotReach("ChatGPT"));
    this.socket.onclose = (ev) => {
      if (!this.closedByUs && !this.completed) this.fail(t().errors.connectionClosed(ev.reason ?? ""));
    };
  }

  get usable(): boolean {
    return this.failure === null && !this.closedByUs;
  }

  configure(): void {
    this.send({
      type: "session.start",
      dictation_session_id: crypto.randomUUID(),
      attempt_id: crypto.randomUUID(),
      config: {
        language: null,
        input_audio_format: "pcm16",
        sample_rate_hz: SAMPLE_RATE,
        num_channels: 1,
        max_buffer_size_bytes: 4194304,
        max_utterance_duration_ms: 30000,
        session_ttl_ms: 300000,
        provider_mode: "streaming_sse",
        transcript_delivery_mode: "segment",
        vad: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
      },
    });
  }

  append(pcm: Uint8Array): void {
    this.send({ type: "audio.append", audio: toBase64(pcm) });
  }

  commit(): void {
    if (this.committed) return;
    this.committed = true;
    this.append(new Uint8Array(ChatGPTSession.TAIL_MS * BYTES_PER_MS));
    this.send({ type: "session.close" });
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
    if (this.failure !== null || this.closedByUs || this.completed) return;
    this.failure = message;
    this.handlers.onError?.(message);
  }

  /** Each utterance's final, or its latest text before one, in order. */
  private text(): string {
    return [...this.utterances.values()].map((u) => u.text.trim()).filter(Boolean).join(" ");
  }

  private show(): void {
    const text = this.text();
    if (text === this.shown) return;
    if (text.startsWith(this.shown)) this.handlers.onDelta?.(text.slice(this.shown.length));
    else this.handlers.onRevise?.(text);
    this.shown = text;
  }

  private handle(raw: string): void {
    let msg: {
      type?: string;
      utterance_id?: string;
      revision?: number;
      text?: string;
      fatal?: boolean;
      error?: { code?: string; message?: string };
      session?: { status?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "transcript.segment":
      case "transcript.final": {
        const id = msg.utterance_id ?? "";
        const revision = msg.revision ?? 0;
        const final = msg.type === "transcript.final";
        const u = this.utterances.get(id);
        // As chatgpt.com: a final replaces anything but a later final; a guess, only an earlier guess.
        if (u && (final ? u.final && revision < u.revision : u.final || revision < u.revision)) return;
        this.utterances.set(id, { revision, text: msg.text ?? "", final });
        this.show();
        break;
      }
      case "transcript.failed":
        this.lost ??= msg.error?.message || t().errors.providerError("ChatGPT");
        break;
      case "session.error":
        if (msg.fatal) this.fail(msg.error?.message || t().errors.providerError("ChatGPT"));
        break;
      case "session.updated":
        if (msg.session?.status !== "closed") break;
        // Before the end of the dictation: the server closed it on its own.
        if (!this.committed) return this.fail(t().errors.connectionClosed(""));
        if (this.lost) return this.fail(this.lost);
        this.completed = true;
        this.handlers.onCompleted?.(this.text());
        break;
    }
  }
}
