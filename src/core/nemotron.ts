import { BYTES_PER_MS, toBase64 } from "./audio";
import { PROVIDERS } from "./providers";
import { RealtimeSession, type SocketFactory } from "./realtime";

export const NEMOTRON_LIVE_URL = "wss://api.dotwave.ai/v1/realtime?model=nemotron-asr-streaming";

/**
 * NVIDIA's Nemotron 3.5 ASR Streaming, run by .wave (dotwave.ai) behind OpenAI's Realtime
 * transcription events.
 *
 * .wave transcribes against a clock that starts with the first audio: audio more than 640 ms ahead
 * of it ends the session, audio behind it counts as silence (measured: 6 s sent at once, then the
 * rest in real time, gave no text at all). So audio goes out no faster than it was spoken: a
 * backlog (the wake word's pre-roll, audio from before the socket opened, a replay) drains at the
 * speed of speech. The first audio is LEAD_MS of silence, so a chunk that comes a little late is
 * still in time.
 *
 * For the same reason silence is sent too, unlike with the other providers; .wave bills the
 * session's length anyway.
 *
 * A session that gets no audio closes after 30 s, the pool's spare included (see SessionPool).
 * No terms, context or language: the language is detected as you speak.
 */
export class NemotronSession extends RealtimeSession {
  private static readonly LEAD_MS = 300;

  private readonly pending: Uint8Array[] = [];
  /** When the first audio went out; 0 before. */
  private startedAt = 0;
  private sentBytes = 0;
  private committed = false;
  private commitSent = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(factory: SocketFactory) {
    super(factory, NEMOTRON_LIVE_URL, "Nemotron");
  }

  configure(): void {
    this.send({
      type: "session.update",
      session: {
        type: "transcription",
        audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: PROVIDERS.nemotron.liveModel }, turn_detection: null } },
      },
    });
  }

  append(pcm: Uint8Array): void {
    this.pending.push(pcm);
    this.drain();
  }

  /** Once the backlog is out. */
  commit(): void {
    this.committed = true;
    this.drain();
  }

  close(): void {
    clearTimeout(this.timer);
    super.close();
  }

  protected opened(): void {
    this.drain();
  }

  /** Sends what the clock allows, and comes back for the rest. */
  private drain(): void {
    clearTimeout(this.timer);
    if (!this.connected || !this.usable) return;
    if (!this.startedAt && this.pending.length) {
      this.startedAt = Date.now();
      this.pending.unshift(new Uint8Array(NemotronSession.LEAD_MS * BYTES_PER_MS));
    }
    let allowed = Math.floor(((Date.now() - this.startedAt + NemotronSession.LEAD_MS) * BYTES_PER_MS) / 2) * 2 - this.sentBytes;
    while (this.pending.length && allowed > 0) {
      const pcm = this.pending[0]!;
      const part = pcm.byteLength <= allowed ? pcm : pcm.subarray(0, allowed);
      if (part === pcm) this.pending.shift();
      else this.pending[0] = pcm.subarray(allowed);
      this.send({ type: "input_audio_buffer.append", audio: toBase64(part) });
      this.sentBytes += part.byteLength;
      allowed -= part.byteLength;
    }
    if (this.pending.length) this.timer = setTimeout(() => this.drain(), 40);
    else if (this.committed && !this.commitSent) {
      this.commitSent = true;
      this.send({ type: "input_audio_buffer.commit" });
    }
  }
}
