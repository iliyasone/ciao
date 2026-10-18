import { BYTES_PER_MS, level, SAMPLE_RATE, toBase64 } from "./audio";
import { t } from "./i18n";
import { PROVIDERS } from "./providers";
import type { LiveSession, RealtimeHandlers, SocketFactory, SocketLike } from "./realtime";
import type { Settings } from "./types";

export const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const VERTEX_LIVE_URL = "wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent";

/**
 * Where a Gemini key works. A key from Google AI Studio calls the Gemini API; a Google Cloud key
 * bound to a service account calls the same models through Vertex AI, in the key's project. Vertex
 * has none of AI Studio's usage tiers (Tier 1 allows the file model 100 requests a day) and bills
 * the project's Cloud billing account.
 */
export interface GeminiEndpoint {
  /** The Google Cloud project number of a Vertex key; null for an AI Studio key. */
  vertexProject: string | null;
}

/** On Vertex the models carry "-preview" and live in the "global" location only (us and eu: 404). */
function vertexModel(project: string, model: string): string {
  return `projects/${project}/locations/global/publishers/google/models/${model}-preview`;
}

/** The live model, as the setup message names it. */
export function liveModelName(ep: GeminiEndpoint): string {
  const model = PROVIDERS.gemini.liveModel;
  return ep.vertexProject ? vertexModel(ep.vertexProject, model) : `models/${model}`;
}

/** The file model's :generateContent on Vertex. */
export function vertexFileUrl(project: string): string {
  return `https://aiplatform.googleapis.com/v1/${vertexModel(project, PROVIDERS.gemini.fileModel)}:generateContent`;
}

/**
 * Tells an AI Studio key from a Vertex one by the answer to GET /v1beta/models on the Gemini API
 * (see geminiEndpoint in main/transcribe.ts); both look alike ("AQ.…"). An AI Studio key gets the
 * models. A Vertex key is refused, and the refusal names the key's project ("consumer":
 * "projects/906271403959"), which Vertex URLs need: API_KEY_SERVICE_BLOCKED when the key is limited
 * to Vertex AI, SERVICE_DISABLED when it isn't but the project has no Gemini API. Another 400, 401
 * or 403 is a wrong key: AI Studio, so its errors read as before. Null: no answer to go by (a 429, a
 * 5xx), so ask again next time.
 */
export function parseGeminiEndpoint(status: number, body: unknown): GeminiEndpoint | null {
  if (status >= 200 && status < 300) return { vertexProject: null };
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  for (const d of Array.isArray(details) ? (details as { reason?: string; metadata?: { consumer?: string } }[]) : []) {
    if (d?.reason !== "API_KEY_SERVICE_BLOCKED" && d?.reason !== "SERVICE_DISABLED") continue;
    const project = /^projects\/(\d+)$/.exec(d.metadata?.consumer ?? "")?.[1];
    if (project) return { vertexProject: project };
  }
  return status === 400 || status === 401 || status === 403 ? { vertexProject: null } : null;
}

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
 * sends interim guesses, each replacing the last, and a final transcript per finished segment, which
 * may differ from the guesses before it.
 *
 * The server ends an activity on its own about 220 s after it started and ignores the audio after
 * that (measured: a 5.5-minute dictation lost its last 100 s), so a long dictation is cut into
 * several, each with its own final: ROLL_AFTER_MS into one, it ends at the next pause, or at
 * ROLL_BY_MS without one. The next may start only once the server reports the end (ACTIVITY_END;
 * an activityStart before that is ignored, measured), so the audio in between is held and sent
 * after it: nothing is lost. Should the server end one first, the next starts right away; then the
 * ~2 s before that are lost.
 *
 * Vertex AI speaks the same protocol at another address, with the model named by its full path.
 *
 * No language codes are sent: without them the language is detected per utterance, mixed Russian and
 * English included.
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

  private socket: SocketLike | null = null;
  /** Sent before the socket opened. The setup is filled in with the model then, when the endpoint is known. */
  private readonly queue: object[] = [];
  private endpoint: GeminiEndpoint | null = null;
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

  /**
   * Gemini sends JSON as binary frames: a browser-style socket needs binaryType = "arraybuffer".
   * The socket opens once the endpoint is known; until then everything waits in the queue.
   */
  constructor(factory: SocketFactory, endpoint: Promise<GeminiEndpoint>) {
    endpoint.then(
      (ep) => {
        if (this.closedByUs) return;
        this.endpoint = ep;
        this.open(factory(ep.vertexProject ? VERTEX_LIVE_URL : GEMINI_LIVE_URL));
      },
      () => this.fail(t().errors.cannotReach("Gemini")),
    );
  }

  private open(socket: SocketLike): void {
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      for (const msg of this.queue.splice(0)) socket.send(this.wire(msg));
      this.handlers.onConnected?.();
    };
    socket.onmessage = (ev) => this.handle(ev.data);
    socket.onerror = () => this.fail(t().errors.cannotReach("Gemini"));
    socket.onclose = (ev) => {
      if (!this.closedByUs && !this.completed) this.fail(t().errors.connectionClosed(ev.reason ?? ""));
    };
  }

  /** The JSON for a message; the setup gets the model's name for the endpoint. */
  private wire(msg: object): string {
    if (!("setup" in msg)) return JSON.stringify(msg);
    const setup = (msg as { setup: object }).setup;
    return JSON.stringify({ setup: { model: liveModelName(this.endpoint!), ...setup } });
  }

  get usable(): boolean {
    return this.failure === null && !this.closedByUs;
  }

  configure(s: Pick<Settings, "keywords">): void {
    // Verbatim: smart mode (no fillers, spoken corrections applied) drops whole sentences now and then.
    const transcription: Record<string, unknown> = { mode: "VERBATIM" };
    const terms = vocabulary(s.keywords);
    if (terms.length) transcription.customVocabulary = terms;
    this.send({
      setup: {
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
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }

  private send(msg: object): void {
    if (this.socket?.readyState === OPEN) this.socket.send(this.wire(msg));
    else this.queue.push(msg);
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
