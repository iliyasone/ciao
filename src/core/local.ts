import { toBase64 } from "./audio";
import { t } from "./i18n";
import type { LiveSession, RealtimeHandlers } from "./realtime";

/**
 * The languages tinyasr recognizes in, sentence by sentence (each one allowed costs a full pass at every pause; the
 * surest wins). Its model has Ukrainian too, but allowing it made things worse: on 43 dictations the text differed
 * from Gemini's in 36% of the words, against 22% with Russian and English, and 24% with Russian alone.
 */
export const LOCAL_LANGS = "ru,en";

/**
 * The on-device recognizer's helper process (native/asr: ciao-asr on desktop), as the host runs it: one command per
 * line in, one JSON object per line out (the protocol is at the top of native/asr/src/main.rs).
 */
export interface HelperLike {
  write(line: string): void;
  onLine: ((line: string) => void) | null;
  /** The process ended (or never started: `error`). */
  onExit: ((error: string | null) => void) | null;
  kill(): void;
}

export type HelperFactory = () => HelperLike;

type Answer = { type: "ready" } | { type: "text"; text: string } | { type: "final"; text: string } | { type: "error"; message: string };

/**
 * A live dictation recognized on this device by tinyasr (Telegram's), one helper process per dictation: started
 * ahead, it loads the model meanwhile (the pool keeps a spare), and takes audio at once (its stdin holds it until
 * then). It re-decodes the open sentence at pauses, so the text shown may change, not only grow.
 */
export class LocalSession implements LiveSession {
  readonly createdAt = Date.now();
  connected = false;
  failure: string | null = null;
  handlers: RealtimeHandlers = {};

  private readonly helper: HelperLike;
  private closedByUs = false;
  private done = false;

  constructor(factory: HelperFactory) {
    this.helper = factory();
    this.helper.onLine = (line) => this.handle(line);
    this.helper.onExit = (error) => {
      if (!this.done) this.fail(error ?? t().errors.providerError("tinyasr"));
    };
  }

  get usable(): boolean {
    return this.failure === null && !this.closedByUs;
  }

  configure(): void {
    this.helper.write(`live ${LOCAL_LANGS}`);
  }

  append(pcm: Uint8Array): void {
    if (pcm.byteLength) this.helper.write(`audio ${toBase64(pcm)}`);
  }

  commit(): void {
    this.helper.write("finish");
  }

  close(): void {
    this.closedByUs = true;
    this.helper.kill();
  }

  private handle(line: string): void {
    let msg: Answer;
    try {
      msg = JSON.parse(line) as Answer;
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.connected = true;
      this.handlers.onConnected?.();
    } else if (msg.type === "text") this.handlers.onRevise?.(msg.text);
    else if (msg.type === "final") {
      this.done = true;
      this.handlers.onCompleted?.(msg.text);
    } else if (msg.type === "error") this.fail(msg.message);
  }

  private fail(message: string): void {
    if (this.failure !== null || this.closedByUs) return;
    this.failure = message;
    this.handlers.onError?.(message);
  }
}

/** A whole recording (24 kHz PCM16) through a helper: its full-context pass, more accurate than the live text. */
export function transcribeLocal(factory: HelperFactory, pcm: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const helper = factory();
    let done = false;
    helper.onLine = (line) => {
      let msg: Answer;
      try {
        msg = JSON.parse(line) as Answer;
      } catch {
        return;
      }
      if (msg.type === "final") {
        done = true;
        resolve(msg.text);
      } else if (msg.type === "error") {
        done = true;
        helper.kill();
        reject(new Error(msg.message));
      }
    };
    helper.onExit = (error) => {
      if (!done) reject(new Error(error ?? t().errors.providerError("tinyasr")));
    };
    helper.write(`file ${LOCAL_LANGS}`);
    const chunk = 24_000 * 2 * 10; // 10 s per line
    for (let i = 0; i < pcm.byteLength; i += chunk) helper.write(`audio ${toBase64(pcm.subarray(i, i + chunk))}`);
    helper.write("finish");
  });
}
